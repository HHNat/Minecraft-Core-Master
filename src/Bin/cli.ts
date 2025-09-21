#!/usr/bin/env node
import { MinecraftDownloader, MinecraftLauncher } from "../index.js";
import { readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const command = args[0];

// Función para obtener la versión desde package.json
function getPackageVersion() {
  try {
    const pkgPath = join(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "desconocida";
  } catch (err) {
    return "desconocida";
  }
}

async function download(version: string, dir: string, concurrency: number = 1, installJava: boolean = false) {
  const Downloader = new MinecraftDownloader();
  try {
    Downloader.on('progress', (msg) => console.log("[ PROGRESS ]", msg));
    Downloader.on('step-done', (msg) => console.log('[ DEBUG ]', msg));
    Downloader.on('warn', (msg) => console.warn('[ WARN ]', msg));
    Downloader.on('error', (err) => console.error('[ ERROR ]', err));
    Downloader.on('info', (msg) => console.log("[ INFO ]", msg));
    Downloader.on('done', (msg) => console.log("[ DONE ]", msg));
    await Downloader.start({
      root: dir,
      version,
      concurrency,
      installJava
    }).finally(() => {
      console.log(`Minecraft se ha descargado exitosamente: Dir. ${dir}, Vers. ${version}, InstallJava: ${installJava}`);
      process.exit(0);
    });
  } catch (err) {
    console.error("Error descargando Minecraft:", err);
    console.timeEnd("Tiempo De Descarga Total :");
  }
}

async function launch(version: string, dir: string, username: string = "Player", debug: boolean = false, memoryMax: string = "2G", memoryMin: string = "512M") {
  try {
    const launcher = new MinecraftLauncher({
      version,
      root: dir,
      debug,
      memory: { min: memoryMin, max: memoryMax },
      authenticator: {
        name: username,
        meta: { type: "mojang" },
      },
    });

    launcher.on('debug', (msg) => console.log('[DEBUG]', msg));
    launcher.on('warn', (msg) => console.warn('[WARN]', msg));
    launcher.on('error', (err) => console.error('[ERROR]', err));
    launcher.on('data', (msg) => console.log(msg));

    await launcher.launch();
  } catch (err) {
    console.error("Falló el lanzamiento:", err);
  }
}

switch (command) {
  case "download":
    // args[3] = concurrency, args[4] = installJava
    download(
      args[1] || "1.12.2",
      args[2] || ".minecraft",
      args[3] ? Number(args[3]) : 1,
      args[4] === "true" // ahora se puede pasar true o false
    );
    break;

  case "launch":
    // args[3] = username, args[4] = debug, args[5] = memoryMax, args[6] = memoryMin
    launch(
      args[1] || "1.12.2",
      args[2] || ".minecraft",
      args[3] || "Player",
      args[4] === "true",
      args[5] || "2G",
      args[6] || "512M"
    );
    break;

  case "-v":
  case "--version":
    console.log(`Minecraft-Core-Master version: ${getPackageVersion()}`);
    break;

  default:
    console.log(`Comandos disponibles:
    download <version> <dir> [concurrency] [installJava]
    launch <version> <dir> <username> [debug] [memoryMax] [memoryMin]
    -v, --version        Muestra la versión del paquete`);
}
