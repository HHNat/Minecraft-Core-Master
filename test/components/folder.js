const { MinecraftFolder } = require('../../dist/index');

console.log("Default:", MinecraftFolder.default.getDefault());

MinecraftFolder.default.setFolder("Steplauncher");
console.log("Custom:", MinecraftFolder.default.getFolder());
