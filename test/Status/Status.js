const { } = require('../../dist/index.js');

async function main() {
    const server = new Status("mc.universocraft.com", 25565);

    try {
        const status = await server.getStatus();
        console.log("Estado del servidor:", status);
    } catch (err) {
        console.error("Error al obtener el estado:", err);
    }
}

main();
