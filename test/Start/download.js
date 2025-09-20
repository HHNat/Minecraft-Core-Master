const { MinecraftDownloader, MinecraftFolder } = require("../../dist/index");

async function main() {
  const downloader = new MinecraftDownloader();

  // Escuchar progreso global
  downloader.on("progress", ({ current, stepPercent, totalPercent }) => {
    console.log(`[PROGRESO] ${current} | Progreso: ${stepPercent}% | Total: ${totalPercent}%`);
    });

  // Escuchar cuando un paso termina
  downloader.on("step-done", (name) => {
    console.log(`[COMPLETADO] ${name}`);
  });

  // Advertencias
  downloader.on("warn", (msg) => {
    console.warn(`[ADVERTENCIA] ${msg}`);
  });

  // Errores
  downloader.on("error", (err) => {
    console.error(`[ERROR] ${err.message}`);
  });

  // Información general
  downloader.on("info", (msg) => {
    console.log(`[INFO] ${msg}`);
  });

  // Cuando todo el proceso finalice
  downloader.on("done", () => {
    console.log(`✅ Descarga completa de todos los componentes de Minecraft!`);
  });
  // Añadir ruta de Carpeta aun que se pueda hacer manualmente
  MinecraftFolder.default.setFolder(".minecraft");
  const Folder = MinecraftFolder.default.getFolder();
  
  // Iniciar descarga
  await downloader.start({
    root: Folder,
    version:"1.12.2",
    concurrency: 5, // False = Descargar 1 x 1 | Number "Ej. 2" Descargara de 2 en 2 ( 2 x 1 )
    installJava: false, /** Descarga de Java Ej. "22", "17", "etc" */ // https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json
    variantJava: "release", // Snapshot | Alpha | Legacy | Beta
    bundleEnabled: false,
    verifySha: true,
  });
}

main().catch(console.error);
