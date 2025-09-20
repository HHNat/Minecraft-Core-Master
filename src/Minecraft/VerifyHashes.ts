/**
 * @author NovaStepStudios
 * @alias StepnickaSantiago
 * @license Apache-2.0
 * @link https://www.apache.org/licenses/LICENSE-2.0
 */
import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
import EventEmitter from "events";
import { TaskLimiter } from "../Utils/Download.js";
import MinecraftBundle from "./Bundle.js";

interface AssetObject { hash: string; size: number; }
interface AssetIndex { objects: Record<string, AssetObject>; }

interface LibraryDownloadInfo { url?: string; sha1?: string; path?: string; }
interface LibraryDownloads { artifact?: LibraryDownloadInfo; classifiers?: Record<string, LibraryDownloadInfo>; }
interface Library { name?: string; downloads?: LibraryDownloads; rules?: any[]; checksums?: Record<string,string>; }

interface VersionJSON {
  id: string;
  libraries?: Library[];
  downloads?: {
    client?: { sha1: string; url: string };
    server?: { sha1: string; url: string };
  };
  assets?: string;
  assetIndex?: { id: string; url: string };
  javaVersion?: { majorVersion?: number } | string;
}

export interface IntegrityOptions {
  ignoreServer?: boolean; // default true (vanilla)
  suppressMissingWarnings?: boolean; // default true (no avisos de faltantes)
}

export class MinecraftIntegrityVerifier extends EventEmitter {
  #root: string;
  #version: string;
  #concurrency: number;
  #ignoreServer: boolean;
  #suppressMissingWarnings: boolean;

  constructor(root: string, version: string, concurrency = 12, options: IntegrityOptions = {}) {
    super();
    this.#root = root;
    this.#version = version;
    this.#concurrency = concurrency;
    this.#ignoreServer = options.ignoreServer ?? true;
    this.#suppressMissingWarnings = options.suppressMissingWarnings ?? true;
  }

  public async start() {
    try {
      this.emit("info", `[Integrity] Iniciando verificación para ${this.#version}`);
      const manifest = await this.#fetchJSON<any>("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json");
      const versionMeta = (manifest.versions || []).find((v: any) => v.id === this.#version);
      if (!versionMeta) throw new Error(`Versión ${this.#version} no encontrada`);

      const versionJSON = await this.#fetchJSON<VersionJSON>(versionMeta.url);

      // Assets
      if (versionJSON.assetIndex?.url) await this.#verifyAssets(versionJSON.assetIndex.url);
      else this.emit("info", "[Assets] No hay assetIndex en el version.json - saltando assets.");

      // Libraries
      await this.#verifyLibraries(versionJSON.libraries || []);

      // Natives
      await this.#verifyNatives(versionJSON.libraries || []);

      // Client
      await this.#verifyClient(versionJSON.downloads?.client);

      // Server (solo si explicitamente permitido)
      if (!this.#ignoreServer) await this.#verifyServer(versionJSON.downloads?.server);

      // Runtime
      await this.#verifyRuntime();

      // Bundle (opcional)
      await this.#verifyBundleIfExists();

      this.emit("done", { version: this.#version });
      this.emit("info", `[Integrity] Verificación completa para ${this.#version}`);
    } catch (err: any) {
      this.emit("error", err);
    }
  }

  /* ---------------------- Utilidades ---------------------- */
  #formatPercent(value: number): string {
    const p = Math.max(0, Math.min(100, value));
    const fixed = p.toFixed(2); // "0.00", "5.12", "99.92", "100.00"
    return p < 10 ? `0${fixed}%` : `${fixed}%`;
  }

  #warnIfMismatch(_fileExists: boolean, hasExpectedSha: boolean, shaOk: boolean | null, messageIfMismatch: string) {
    // Solo advertimos si SHA esperado y no coincide.
    if (hasExpectedSha && shaOk === false) this.emit("warn", messageIfMismatch);
  }

  #shouldReportMissing(): boolean {
    return !this.#suppressMissingWarnings;
  }

  /* ---------------------- Assets ---------------------- */
  async #verifyAssets(assetIndexUrl: string) {
    try {
      this.emit("info", "[Assets] Descargando assetIndex...");
      const assetIndex: AssetIndex = await this.#fetchJSON<AssetIndex>(assetIndexUrl);
      const assets = Object.entries(assetIndex.objects || {}) as [string, AssetObject][];
      const limiter = new TaskLimiter(this.#concurrency);
      let verified = 0;
      const total = assets.length;

      const tasks = assets.map(([logicalPath, { hash }]) =>
        limiter.limit(async () => {
          const subDir = hash.slice(0, 2);
          const filePath = path.join(this.#root, "assets", "objects", subDir, hash);
          const exists = fs.existsSync(filePath);
          let ok: boolean | null = null;
          if (exists) {
            ok = await this.#verifyFile(filePath, hash);
            this.#warnIfMismatch(true, true, ok, `[Assets] SHA mismatch: ${logicalPath} -> ${filePath}`);
          } else {
            // archivo faltante: en modo vanilla lo ignoramos; si se configura lo contrario, lo reporta
            if (this.#shouldReportMissing()) this.emit("warn", `[Assets] faltante: ${logicalPath} -> ${filePath}`);
          }

          verified++;
          const pct = (verified / total) * 100;
          const pctText = this.#formatPercent(pct);
          this.emit("progress", {
            type: "Assets",
            current: `${verified}/${total}`,
            stepPercent: pctText,
            totalPercent: pctText,
          });
        })
      );

      await Promise.all(tasks);
      this.emit("info", `[Assets] Verificados ${verified}/${total}`);
    } catch (err: any) {
      this.emit("warn", `[Assets] fallo verificación: ${err.message || err}`);
    }
  }

  /* ---------------------- Libraries ---------------------- */
  async #verifyLibraries(libraries: Library[]) {
    if (!libraries || libraries.length === 0) {
      this.emit("info", "[Libraries] No hay librerías para verificar.");
      return;
    }
    this.emit("info", "[Libraries] Verificando librerías...");
    const limiter = new TaskLimiter(this.#concurrency);
    let verified = 0;
    const total = libraries.length;

    const tasks = libraries.map(lib => limiter.limit(async () => {
      try {
        const artifact = lib.downloads?.artifact;
        let expectedSha: string | undefined = artifact?.sha1;
        let filePath: string | undefined;

        if (artifact?.path) {
          filePath = path.join(this.#root, artifact.path);
        } else if (artifact?.url) {
          const fileName = path.basename(new URL(artifact.url).pathname);
          filePath = path.join(this.#root, "libraries", fileName);
        } else if (lib.name) {
          const generated = this.#mavenPathFromName(lib.name);
          if (generated) filePath = path.join(this.#root, "libraries", generated);
        }

        if (!expectedSha && lib.checksums) expectedSha = Object.values(lib.checksums)[0];

        if (!filePath) {
          // no hay path inferible: no hacemos nada
        } else {
          const exists = fs.existsSync(filePath);
          if (!exists) {
            if (this.#shouldReportMissing()) this.emit("warn", `[Libraries] faltante: ${lib.name} -> ${filePath}`);
          } else if (expectedSha) {
            const ok = await this.#verifyFile(filePath, expectedSha);
            this.#warnIfMismatch(true, true, ok, `[Libraries] SHA mismatch: ${lib.name} -> ${filePath}`);
          } // si existe y no hay sha, lo consideramos OK
        }
      } catch (err: any) {
        this.emit("warn", `[Libraries] error verificando ${lib.name}: ${err.message || err}`);
      } finally {
        verified++;
        const pct = (verified / total) * 100;
        const pctText = this.#formatPercent(pct);
        this.emit("progress", { type: "Libraries", current: `${verified}/${total}`, stepPercent: pctText, totalPercent: pctText });
      }
    }));

    await Promise.all(tasks);
    this.emit("info", `[Libraries] Completadas ${verified}/${total}`);
  }

  /* ---------------------- Natives ---------------------- */
  async #verifyNatives(libraries: Library[]) {
    const natives = (libraries || []).filter(l => (l.downloads?.classifiers && Object.keys(l.downloads!.classifiers!).length > 0) || (l.name && l.name.includes("natives")));
    if (natives.length === 0) {
      this.emit("info", "[Natives] No hay nativos detectados para verificar.");
      return;
    }
    this.emit("info", "[Natives] Verificando nativos...");
    const limiter = new TaskLimiter(this.#concurrency);
    let verified = 0;
    const total = natives.length;

    const tasks = natives.map(lib => limiter.limit(async () => {
      try {
        const classifiers = lib.downloads?.classifiers;
        let candidate: LibraryDownloadInfo | undefined;
        if (classifiers && Object.keys(classifiers).length) {
          const key = Object.keys(classifiers)[0];
          candidate = classifiers[key || ""];
        } else if (lib.downloads?.artifact) {
          candidate = lib.downloads.artifact;
        }

        if (!candidate) {
          // nada que verificar
        } else {
          const filePath = candidate.path ? path.join(this.#root, candidate.path) : (candidate.url ? path.join(this.#root, "libraries", path.basename(new URL(candidate.url).pathname)) : undefined);
          if (filePath) {
            const exists = fs.existsSync(filePath);
            if (!exists) {
              if (this.#shouldReportMissing()) this.emit("warn", `[Natives] faltante: ${lib.name} -> ${filePath}`);
            } else if (candidate.sha1) {
              const ok = await this.#verifyFile(filePath, candidate.sha1);
              this.#warnIfMismatch(true, true, ok, `[Natives] SHA mismatch: ${lib.name} -> ${filePath}`);
            }
          }
        }
      } catch (err: any) {
        this.emit("warn", `[Natives] error verificando ${lib.name}: ${err.message || err}`);
      } finally {
        verified++;
        const pct = (verified / total) * 100;
        const pctText = this.#formatPercent(pct);
        this.emit("progress", { type: "Natives", current: `${verified}/${total}`, stepPercent: pctText, totalPercent: pctText });
      }
    }));

    await Promise.all(tasks);
    this.emit("info", `[Natives] Completadas ${verified}/${total}`);
  }

  /* ---------------------- Client & Server ---------------------- */
  async #verifyClient(client?: { sha1: string; url: string } | undefined) {
    if (!client) {
      this.emit("info", "[Client] No hay cliente a verificar.");
      return;
    }
    this.emit("info", "[Client] Verificando cliente...");
    try {
      if (!client.url || !client.sha1) {
        this.emit("info", "[Client] URL o SHA1 faltante - saltando verificación exacta");
        return;
      }

      // Nombre local preferido: <version>.jar cuando la URL es genérica (client.jar / minecraft.jar)
      let remoteName = path.basename(new URL(client.url).pathname);
      if (/^(client|minecraft)\.jar$/i.test(remoteName)) {
        remoteName = `${this.#version}.jar`;
      }
      const filePath = path.join(this.#root, "versions", this.#version, remoteName);

      const exists = fs.existsSync(filePath);
      if (!exists) {
        // en modo vanilla no reportamos faltantes; solo reportamos en caso de que se haya desactivado suppressMissingWarnings
        if (this.#shouldReportMissing()) this.emit("warn", `[Client] Cliente faltante -> ${filePath}`);
        return;
      }

      const ok = await this.#verifyFile(filePath, client.sha1);
      this.#warnIfMismatch(true, true, ok, `[Client] SHA mismatch -> ${filePath}`);
      if (ok) this.emit("info", `[Client] OK -> ${filePath}`);
    } catch (err: any) {
      this.emit("warn", `[Client] Error: ${err.message || err}`);
    }
  }

  async #verifyServer(server?: { sha1: string; url: string } | undefined) {
    if (!server) {
      // no hay server definido: no hacemos nada
      return;
    }
    // solo verificar si ignoreServer == false
    if (this.#ignoreServer) return;

    this.emit("info", "[Server] Verificando server.jar...");
    try {
      if (!server.url || !server.sha1) {
        this.emit("info", "[Server] URL o SHA1 faltante - saltando verificación exacta");
        return;
      }
      const remoteName = path.basename(new URL(server.url).pathname);
      const filePath = path.join(this.#root, "versions", this.#version, remoteName === "server.jar" ? `${this.#version}-server.jar` : remoteName);

      const exists = fs.existsSync(filePath);
      if (!exists) {
        if (this.#shouldReportMissing()) this.emit("warn", `[Server] server.jar faltante -> ${filePath}`);
        return;
      }
      const ok = await this.#verifyFile(filePath, server.sha1);
      this.#warnIfMismatch(true, true, ok, `[Server] SHA mismatch -> ${filePath}`);
      if (ok) this.emit("info", `[Server] OK -> ${filePath}`);
    } catch (err: any) {
      this.emit("warn", `[Server] Error: ${err.message || err}`);
    }
  }

  /* ---------------------- Runtime ---------------------- */
  async #verifyRuntime() {
    const runtimeDir = path.join(this.#root, "runtime");
    if (!fs.existsSync(runtimeDir)) {
      this.emit("info", "[Runtime] No se encontró carpeta runtime — saltando verificación Java.");
      return;
    }

    const possibleManifest = path.join(runtimeDir, "manifest.json");
    if (fs.existsSync(possibleManifest)) {
      try {
        const manifest = JSON.parse(await fs.promises.readFile(possibleManifest, "utf-8"));
        const files = manifest.files ?? manifest;
        const entries = Object.entries(files as Record<string, any>);
        const limiter = new TaskLimiter(this.#concurrency);
        let verified = 0;
        const total = entries.length;

        const tasks = entries.map(([rel, info]) =>
          limiter.limit(async () => {
            const abs = path.join(runtimeDir, rel.replace(/\//g, path.sep));
            const sha1 = info?.sha1 ?? info?.hash;
            const exists = fs.existsSync(abs);
            if (!exists) {
              if (this.#shouldReportMissing()) this.emit("warn", `[Runtime] Archivo faltante: ${abs}`);
            } else if (sha1) {
              const ok = await this.#verifyFile(abs, sha1);
              this.#warnIfMismatch(true, true, ok, `[Runtime] SHA mismatch: ${abs}`);
            }
            verified++;
            const pctText = this.#formatPercent((verified / total) * 100);
            this.emit("progress", { type: "Runtime", current: `${verified}/${total}`, stepPercent: pctText, totalPercent: pctText });
          })
        );

        await Promise.all(tasks);
        this.emit("info", `[Runtime] Verificado ${verified}/${total}`);
        return;
      } catch (err: any) {
        this.emit("warn", `[Runtime] Error leyendo manifest runtime: ${err.message}. Se usará verificación básica.`);
      }
    }

    const files = await this.#walkDir(runtimeDir);
    let verified = 0;
    for (const f of files) {
      try {
        const st = await fs.promises.stat(f);
        if (st.size === 0 && this.#shouldReportMissing()) this.emit("warn", `[Runtime] Archivo vacío: ${f}`);
      } catch {
        if (this.#shouldReportMissing()) this.emit("warn", `[Runtime] Archivo faltante: ${f}`);
      } finally {
        verified++;
      }
    }
    this.emit("info", `[Runtime] Revisión básica completada - archivos inspeccionados: ${verified}`);
  }

  /* ---------------------- Bundle ---------------------- */
  async #verifyBundleIfExists() {
    try {
      const bundleManager = new MinecraftBundle({ path: this.#root, ignored: [] });
      const all = await bundleManager.getAll();
      if (!all || all.length === 0) return;

      const normalized = await bundleManager.getBundle(all);
      const limiter = new TaskLimiter(this.#concurrency);
      let verified = 0;
      const total = normalized.length;

      const tasks = normalized.map(it => limiter.limit(async () => {
        try {
          if (it.type === "CFILE") {
            const exists = fs.existsSync(it.path);
            if (!exists && this.#shouldReportMissing()) this.emit("warn", `[Bundle] CFILE faltante: ${it.path}`);
          } else {
            const exists = fs.existsSync(it.path);
            if (!exists) {
              if (this.#shouldReportMissing()) this.emit("warn", `[Bundle] faltante: ${it.path}`);
            } else {
              if (it.sha1) {
                const ok = await this.#verifyFile(it.path, it.sha1);
                this.#warnIfMismatch(true, true, ok, `[Bundle] sha1 mismatch: ${it.path}`);
              }
              if (it.size) {
                try {
                  const st = fs.statSync(it.path);
                  if (st.size !== it.size && this.#shouldReportMissing()) this.emit("warn", `[Bundle] size mismatch: ${it.path} (actual ${st.size} != esperado ${it.size})`);
                } catch {}
              }
            }
          }
        } catch (err: any) {
          this.emit("warn", `[Bundle] Error verificando item ${it.path}: ${err.message || err}`);
        } finally {
          verified++;
          const pct = (verified / total) * 100;
          const pctText = this.#formatPercent(pct);
          this.emit("progress", { type: "Bundle", current: `${verified}/${total}`, stepPercent: pctText, totalPercent: pctText });
        }
      }));

      await Promise.all(tasks);
      this.emit("info", `[Bundle] Verificación completada ${verified}/${total}`);
    } catch (err: any) {
      // no crítico
    }
  }

  /* ---------------------- Helpers de archivo y JSON ---------------------- */
  async #verifyFile(filePath: string, expectedHash?: string) {
    if (!expectedHash) return fs.existsSync(filePath);
    if (!fs.existsSync(filePath)) return false;
    return new Promise<boolean>((resolve, reject) => {
      const hash = crypto.createHash("sha1");
      const stream = fs.createReadStream(filePath);
      stream.on("data", chunk => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex") === expectedHash));
      stream.on("error", reject);
    });
  }

  #mavenPathFromName(name: string | undefined): string | null {
    if (!name) return null;
    const parts = name.split(":");
    if (parts.length < 3) return null;
    const [group, artifact, version] = parts;
    const jarName = `${artifact}-${version}.jar`;
    const groupPath = group?.replace(/\./g, "/");
    return path.join(groupPath || "", artifact || "", version || "", jarName);
  }

  async #walkDir(dir: string) {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    const items = await fs.promises.readdir(dir);
    for (const it of items) {
      const p = path.join(dir, it);
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) out.push(...(await this.#walkDir(p)));
      else out.push(p);
    }
    return out;
  }

  async #fetchJSON<T>(url: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      https.get(url, res => {
        if (res.statusCode !== 200) return reject(new Error(`Error al descargar JSON: ${url} (status ${res.statusCode})`));
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data) as T); }
          catch (err: any) { reject(err); }
        });
      }).on("error", reject);
    });
  }
}
