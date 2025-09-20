/**
 * @author NovaStepStudios
 * @alias StepnickaSantiago
 * @license Apache-2.0
 * @link https://www.apache.org/licenses/LICENSE-2.0
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { TaskLimiter } from "../Utils/Download.js";

import { MinecraftNativesDownloader } from "../Minecraft/Natives.js";
import { MinecraftLibrariesDownloader } from "../Minecraft/Libraries.js";
import { MinecraftClientDownloader } from "../Minecraft/Version.js";
import { MinecraftAssetsDownloader } from "../Minecraft/Assets.js";
import { LwjglDownloader } from "../Minecraft/Lwjgl.js";
import { downloadLoggingXml } from "../Minecraft/Logging.js";
import { getFileHash } from "../Utils/Index.js";
import RuntimeDownloader from "../Minecraft/Runtime.js";
import MinecraftBundle, { BundleItem } from "../Minecraft/Bundle.js";

type VersionInput = string | { id: string; [key: string]: any };
type JavaOption = boolean | string | "auto";

interface DownloaderOptions {
  root: string;
  version: VersionInput;
  concurrency?: number | false | undefined;
  installJava?: JavaOption | "auto" | undefined;
  variantJava?: "release" | "snapshot" | "alpha" | "beta" | undefined;
  verifySha?: boolean;
  bundleEnabled?: boolean;
  bundle?: BundleItem[] | undefined;
}

interface InstancieOptions extends DownloaderOptions {
  instancieId?: string;
  manifest?: {
    name: string;
    description?: string | string[];
    icon?: string;
    created?: string;
  };
  userConfig?: any;
  gameConfig?: {
    resolution?: { width: string; height: string; fullscreen: boolean };
    memory?: { min: string; max: string };
    javaArgs?: string[];
    gameArgs?: string[];
  };
}

interface ErrorContext {
  task?: string;
  version?: string;
  root?: string;
  step?: string;
  profile?: string;
  progress?: string;
  additionalInfo?: string;
}

export class MinecraftDownloader extends EventEmitter {
  private tasks: (() => Promise<void>)[] = [];
  private completedSteps = 0;
  private totalSteps = 0;
  private controller = new AbortController();

  constructor() {
    super();
  }

  public async start(options: DownloaderOptions) {
    const { root, version, concurrency = 1, installJava = "auto", verifySha = true, bundle, bundleEnabled = true } = options;

    if (!root) throw new Error("Debe especificar la carpeta raíz (root).");
    if (!version) throw new Error("Debe especificar la versión de Minecraft.");

    this.tasks = [];
    this.completedSteps = 0;
    this.controller = new AbortController();

    this.ensureLauncherProfiles(root);
    this.tasks.push(() => this.downloadLoggingXml(root, version));

    // Detectar legacy assets
    const versionStr = typeof version === "string" ? version : version.id;
    const [major = 0, minor = 0, patch = 0] = versionStr.split(".").map(n => Number(n) || 0);
    const legacyAssets = major < 1 || (major === 1 && minor < 6) || (major === 1 && minor === 6 && patch < 1);

    const downloaders: [string, any][] = [
      ["LWJGL", LwjglDownloader],
      ["Nativos", MinecraftNativesDownloader],
      ["Librerías", MinecraftLibrariesDownloader],
      [
        "Assets",
        class extends MinecraftAssetsDownloader {
          constructor(rootPath: string, versionId: string) {
            super(rootPath, versionId, 20, 10, true, legacyAssets);
          }
        },
      ],
      ["Cliente", MinecraftClientDownloader],
    ];

    if (bundle?.length && bundleEnabled) {
      downloaders.push([
        "Bundle",
        class BundleDownloader extends EventEmitter {
          private root: string;
          private bundleList: BundleItem[];

          constructor(rootPath: string, bundleItems: BundleItem[]) {
            super();
            this.root = rootPath;
            this.bundleList = bundleItems;
          }

          public async start() {
            const bundleManager = new MinecraftBundle({ path: this.root, ignored: [] });

            bundleManager.on("progress", (data: { filePath: string; index: number; total: number }) => {
              const stepPercent = ((data.index + 1) / data.total) * 100;
              this.emit("progress", {
                current: data.filePath,
                stepPercent,
              });
            });

            const toDownload = await bundleManager.checkBundle(this.bundleList);

            if (toDownload.length > 0) {
              this.emit("warn", `Archivos corruptos o faltantes: ${toDownload.map(f => f.path).join(", ")}`);
            }

            await bundleManager.checkFiles(this.bundleList);

            this.emit("done");
          }
        }.bind(null, root, bundle),
      ]);
    }

    if (installJava !== false) {
      let javaVersion: string;
      if (installJava === "auto" || installJava === true) {
        javaVersion = await this.getRecommendedJavaVersion(version);
      } else if (typeof installJava === "string") {
        javaVersion = installJava;
      } else {
        javaVersion = await this.getRecommendedJavaVersion(version);
      }

      const userVariant = options.variantJava || "release";
      const variantMap: Record<string, "alpha" | "beta" | "delta" | "gamma" | "gamma-snapshot" | "jre-legacy"> = {
        release: "gamma",
        snapshot: "gamma-snapshot",
        alpha: "alpha",
        beta: "beta",
      };
      const variantJava = variantMap[userVariant] || "gamma";

      downloaders.unshift([
        "Java",
        class extends RuntimeDownloader {
          constructor(rootPath: string) {
            super({ root: rootPath, javaVersion, variant: variantJava });
          }
        },
      ]);
    }

    this.totalSteps = downloaders.length;
    for (const [name, ClassRef] of downloaders) {
      this.tasks.push(() => this.runDownloader(name, ClassRef, root, version));
    }

    this.emitProgress("Iniciando descarga...", 0);

       try {
      const limiter = concurrency === false ? null : new TaskLimiter(concurrency || 1);

      const executeTask = (task: () => Promise<void>) => {
        if (limiter) {
          return limiter.limit(() => this.guardTask(task));
        } else {
          return this.guardTask(task);
        }
      };

      await Promise.all(this.tasks.map(executeTask));
      
      if (!this.controller.signal.aborted) {
        this.emitProgress("Descarga completada", 100);
        this.emit("info", "Descarga completa.");

        if (verifySha) {
          this.emit("info", "Iniciando verificación SHA/HASH de todos los componentes (modo VANILLA CLIENT only)...");
          try {
            const versionStr = typeof version === "string" ? version : version.id;
            const concurrencyNum = concurrency === false ? 4 : Math.max(4, Number(concurrency || 4));

            // Import dinámico del verificador
            const mod = await import("../Minecraft/VerifyHashes.js");
            const VerifierClass = mod.MinecraftIntegrityVerifier;

            // Instanciamos en modo VANILLA: ignorar server.jar y silenciar warnings por faltantes
            const verifier = new VerifierClass(
              root,
              versionStr,
              concurrencyNum,
              { ignoreServer: true, suppressMissingWarnings: true } // configuración vanilla-only
            );

            const parsePercent = (p: any): number => {
              if (typeof p === "number") return Number.isFinite(p) ? p : 0;
              if (typeof p === "string") {
                // aceptar "05.12%", "5.12%", "00.00%", "5.12" etc.
                const n = parseFloat(p.replace("%", "").replace(/,/g, ".").replace(/[^\d.\-]/g, ""));
                return Number.isFinite(n) ? n : 0;
              }
              return 0;
            };

            const formatPercentText = (n: number) => {
              const clamped = Math.max(0, Math.min(100, n));
              const fixed = clamped.toFixed(2); // "0.00", "5.12", "99.92", "100.00"
              return clamped < 10 ? `0${fixed}%` : `${fixed}%`; // "00.00%", "05.12%", "99.92%", "100.00%"
            };

            verifier.on("progress", (d: any) => {
              const raw = d.percent ?? d.stepPercent ?? d.totalPercent ?? d.percentText ?? 0;
              const pct = Math.min(100, parsePercent(raw));
              const pctText = formatPercentText(pct);
              this.emit("progress", {
                current: `Verificando ${d.type ?? d.current ?? "componentes"}`,
                stepPercent: Number(pct.toFixed(2)),
                totalPercent: Number(pct.toFixed(2)),
                stepPercentText: pctText,
              });
            });

            verifier.on("info", (m: any) => this.emit("info", `[Integrity] ${m}`));
            verifier.on("warn", (m: any) => this.emit("warn", `[Integrity] ${m}`));
            verifier.on("error", (e: any) => this.emit("error", `[Integrity] ${e}`));
            verifier.on("done", (info: any) => this.emit("info", `[Integrity] OK -> ${JSON.stringify(info)}`));

            await verifier.start();

            this.emit("info", "Verificación SHA completada (modo VANILLA).");
          } catch (err: any) {
            this.emit("warn", `Falló la verificación SHA global: ${err?.message ?? String(err)}`);
          }
        } else {
          this.emit("info", "Verificación SHA desactivada por el usuario (verifySha=false).");
        }

        this.emit("done", "¡Descarga e integridad completadas!");
      }

      if (!this.controller.signal.aborted) {
        this.emitProgress("Descarga completada", 100);
        this.emit("done","¡Descarga Exitosa!");
      }
    } catch (err: any) {
      this.emit("error", err);
    }
  }

  public async createInstancie(options: InstancieOptions) {
    const { root } = options;
    if (!root) throw new Error("Debes especificar la carpeta raíz (root)");
    const safeId = (options.manifest?.name || `inst_${Date.now()}`)
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_]/g, "");
    const instancieId = options.instancieId || safeId;
    const instanciePath = path.join(root, "instancies", instancieId);
    if (!fs.existsSync(instanciePath)) fs.mkdirSync(instanciePath, { recursive: true });

    const config = {
      id: instancieId,
      version: options.version || "Unknown",
      manifest: {
        name: options.manifest?.name || "Instancia sin nombre",
        description: options.manifest?.description || "",
        icon: options.manifest?.icon || "",
        created: new Date().toISOString(),
      },
      userConfig: options.userConfig || { authenticator: null },
      gameConfig: options.gameConfig || {
        resolution: { width: "854", height: "480", fullscreen: false },
        memory: { min: "512M", max: "2G" },
        javaArgs: [],
        gameArgs: [],
      },
    };
    fs.writeFileSync(path.join(instanciePath, "Manifest-Instancie.json"), JSON.stringify(config, null, 2), "utf-8");
    this.emit("info", `Manifest-Instancie.json creado en ${instanciePath}`);

    return this.start({
      root: instanciePath,
      version: options.version,
      concurrency: options.concurrency,
      installJava: options.installJava,
      variantJava: options.variantJava,
      bundle: options.bundle,
    });
  }

  private async getRecommendedJavaVersion(version: VersionInput): Promise<string> {
    const verId = typeof version === "string" ? version : version.id;

    try {
      const manifestUrl = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
      const respManifest = await fetch(manifestUrl);
      if (!respManifest.ok) throw new Error(`Error descargando version_manifest_v2.json: ${respManifest.status}`);
      const manifest = await respManifest.json();
      const versionInfo = manifest.versions.find((v: any) => v.id === verId);
      if (!versionInfo) throw new Error(`Versión ${verId} no encontrada en manifest`);
      const respVersionJson = await fetch(versionInfo.url);
      if (!respVersionJson.ok) throw new Error(`Error descargando ${versionInfo.url}: ${respVersionJson.status}`);
      const versionJson = await respVersionJson.json();
      if (versionJson.javaVersion?.majorVersion) {
        return String(versionJson.javaVersion.majorVersion);
      }
      if (/^1\.1[7-9]|^1\.20/.test(verId)) return "17";
      return "22";
    } catch (err: any) {
      console.warn(`[Java Auto] No se pudo obtener la versión de Java de Mojang: ${err.message}`);
      return "22";
    }
  }

  public stop() {
    this.controller.abort();
    this.emit("warn", "Descarga cancelada por el usuario.");
  }

  private async guardTask(task: () => Promise<void>) {
    if (this.controller.signal.aborted) return;
    try {
      await task();
    } catch (err: any) {
      this.emit("warn", `Tarea fallida: ${err.message}`);
    }
  }

  private async downloadLoggingXml(root: string, version: VersionInput) {
    if (this.controller.signal.aborted) return;
    try {
      const versionId = typeof version === "string" ? version : version.id;
      const xmlPath = await downloadLoggingXml(versionId, root);
      this.completedSteps++;
      this.emitStepDone("Logging XML");
      this.emit("info", `Logging XML descargado en: ${xmlPath}`);
      this.emitProgress("Logging XML", 100);
    } catch (err: any) {
      this.handleError(err, "Logging XML", version, root);
    }
  }

  private runDownloader(name: string, ClassRef: any, root: string, version: VersionInput) {
    return new Promise<void>((resolve, reject) => {
      if (this.controller.signal.aborted) return resolve();

      let instance: any;
      try {
        instance = new ClassRef(root, version);
      } catch (err: any) {
        this.handleError(err, name, version, root);
        return reject(err);
      }

      ["info", "warn", "error"].forEach(evt =>
        instance.on(evt, (...args: any[]) => {
          if (evt === "error") {
            this.handleError(args[0], name, version, root);
            reject(args[0]);
          } else {
            this.emit(evt, `[${name}]`, ...args);
          }
        })
      );

      instance.on("progress", (progress: any) => {
        let stepPercent = 0;
        if (typeof progress === "number") stepPercent = progress;
        else if (progress.current != null && progress.total != null && progress.total > 0)
          stepPercent = (progress.current / progress.total) * 100;
        else if (progress.percent != null) stepPercent = progress.percent;

        const overallPercent =
          ((this.completedSteps + stepPercent / 100) / this.totalSteps) * 100;

        this.emit("progress", {
          current: `${name} | ${progress.current}/${progress.total || ""}`,
          stepPercent: Number(stepPercent.toFixed(2)),
          totalPercent: Number(overallPercent.toFixed(2)),
        });
      });

      const finalize = async () => {
        this.completedSteps++;
        this.emitStepDone(name);
        this.emitProgress(`${name} completado`, 100);
        try {
          await this.verifyDownloaderIntegrity(name, instance);
        } catch (err) {
          this.emit("warn", `[${name}] Error verificando integridad: ${err}`);
        }
        resolve();
      };

      if (typeof instance.start === "function") {
        instance.start()
          .then(finalize)
          .catch(reject);
      } else {
        process.nextTick(finalize);
      }
    });
  }


  private emitStepDone(name: string) {
    this.emit("step-done", name);
  }

  private handleError(err: Error, task: string, version: VersionInput, root: string) {
    const additionalInfo = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
    this.saveErrorLog(err, {
      task,
      version: typeof version === "string" ? version : version.id,
      root,
      step: task,
      profile: "UnknownUser",
      additionalInfo,
    });
    this.emit("error", new Error(`[${task}] ${err.message}`));
  }

  private saveErrorLog(err: Error, context: ErrorContext = {}) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now
      .getDate()
      .toString()
      .padStart(2, "0")}`;
    const logDir = path.resolve(context.root || "./", "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const fileName = `minecraft-core-master_${dateStr}_${now.getTime()}_${context.profile || "UnknownUser"}.log`;
    const logContent = `
============== MINECRAFT CORE MASTER ERROR LOG ================
DATE       : ${now.toISOString()}
PROFILE    : ${context.profile || "UnknownUser"}
VERSION    : ${context.version || "UnknownVersion"}
OS         : ${process.platform}
COMPONENT  : Downloader -> ${context.task || "General"}
STEP       : ${context.step || "N/A"}
PROGRESS   : ${context.progress || "0.00% / 100.00%"}
ROOT       : ${context.root || "UnknownRoot"}
ADDITIONAL : ${context.additionalInfo || "N/A"}

ERROR MESSAGE:
${err.message}

STACKTRACE:
${err.stack}
===============================================================
`;
    fs.writeFileSync(path.join(logDir, fileName), logContent, "utf-8");
    console.error(`❌ [ERROR LOG] Guardado en: ${path.join(logDir, fileName)}`);
  }

  private ensureLauncherProfiles(root: string) {
    const filePath = path.join(root, "launcher_profiles.json");
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({ profiles: {}, version: 3 }, null, 2), "utf-8");
      this.emit("info", "launcher_profiles.json creado de forma básica");
    }
  }
  private async verifyDownloaderIntegrity(name: string, instance: any) {
    if (typeof instance.getBundle === 'function') {
      const bundle: BundleItem[] = await instance.getBundle();
      const failedFiles: BundleItem[] = [];

      for (const file of bundle) {
        if (!fs.existsSync(file.path)) {
          failedFiles.push(file);
          continue;
        }
        if (file.sha1) {
          const hash = await getFileHash(file.path);
          if (hash !== file.sha1) failedFiles.push(file);
        }
        if (file.size) {
          const stats = fs.statSync(file.path);
          if (stats.size !== file.size) failedFiles.push(file);
        }
      }

      if (failedFiles.length > 0) {
        this.emit("warn", `[${name}] Archivos corruptos o incompletos detectados: ${failedFiles.map(f => f.path).join(", ")}`);
      } else {
        this.emit("info", `[${name}] Integridad verificada correctamente.`);
      }
    }
  }

  private emitProgress(current: string, stepPercent: number) {
    const formattedStep = (stepPercent ?? 0).toFixed(2);

    const totalPercent = (
      (this.completedSteps / this.totalSteps) +
      (stepPercent / 100 / this.totalSteps)
    ) * 100;

    this.emit("progress", {
      current,
      stepPercent: Number(formattedStep),
      totalPercent: Number(totalPercent.toFixed(2)),
    });
  }
}
