const { MinecraftLauncher, Mojang, MinecraftFolder } = require('../../dist/index');

(async()=>{
  const user = await Mojang.login("SantiagoStepnicka"); // user ahora tiene el objeto devuelto
  MinecraftFolder.default.setFolder(".minecraft");
  const Folder = MinecraftFolder.default.getFolder();

  // Configuración del launcher
  const launcherOptions = {
    version: 'fabric-loader-0.17.2-1.12.2',                // Cambia por la versión que tengas
    root: Folder,
    javaPath: 'C:/Program Files/Java/jre1.8.0_451/bin/javaw.exe',
    debug: true,
    memory:{
      min: "512M",
      max: "4G"
    },
    authenticator: user,
    window: {
      width: null,
      height: null,
      fullscreen: false
    }
  };

  // Crear instancia del launcher
  const launcher = new MinecraftLauncher(launcherOptions);

  // Eventos para logs
  launcher.on('debug', (msg) => console.log('[DEBUG]', msg));
  launcher.on('warn', (msg) => console.warn('[WARN]', msg));
  launcher.on('error', (err) => console.error('[ERROR]', err));
  launcher.on('data', (msg) => console.log(msg));

  try {
    await launcher.launch();
  } catch (err) {
    console.error('Falló el lanzamiento:', err);
  }
})();