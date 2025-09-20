/**
 * @author NovaStepStudios
 * @alias StepnickaSantiago
 * @license Apache-2.0
 * @link https://www.apache.org/licenses/LICENSE-2.0
 */
import net from 'net';

import { MinecraftDownloader } from "./Components/download.js";
import { MinecraftLauncher } from "./Components/launch.js";
import { MrpackExtractor } from "./Minecraft-Mods/MrpackExtractor.js";
import { CFModpackExtractor } from "./Minecraft-Mods/CurseforgeModpack.js";
import * as Mojang from './Authenticator/Mojang.js';
import Microsoft from './Authenticator/Microsoft.js';
import NovaAZauth from './Authenticator/NovaAZauth.js';
import * as MinecraftFolder from "./Minecraft/Extras/Folder.js";

class CustomBuffer {
    private buffer: Buffer;
    private offsetValue: number = 0;

    constructor(existingBuffer: any = Buffer.alloc(48)) {
        this.buffer = existingBuffer;
    }

    writeletInt(val: number) {
        while (true) {
            if ((val & 0xFFFFFF80) === 0) return this.writeUByte(val);
            this.writeUByte((val & 0x7F) | 0x80);
            val = val >>> 7;
        }
    }

    writeString(string: string) {
        this.writeletInt(string.length);
        if (this.offsetValue + string.length >= this.buffer.length) {
            this.buffer = Buffer.concat([this.buffer, Buffer.alloc(string.length)]);
        }
        this.buffer.write(string, this.offsetValue, string.length, "utf-8");
        this.offsetValue += string.length;
    }

    writeUShort(val: number) {
        this.writeUByte(val >> 8);
        this.writeUByte(val & 0xFF);
    }

    writeUByte(val: number) {
        if (this.offsetValue >= this.buffer.length) {
            this.buffer = Buffer.concat([this.buffer, Buffer.alloc(50)]);
        }
        this.buffer.writeUInt8(val, this.offsetValue++);
    }

    readletInt(): number {
        let val = 0;
        let count = 0;
        while (true) {
            const i = this.buffer.readUInt8(this.offsetValue++);
            val |= (i & 0x7F) << (count++ * 7);
            if ((i & 0x80) !== 128) break;
        }
        return val;
    }

    readString(): string {
        const length = this.readletInt();
        const str = this.buffer.toString("utf-8", this.offsetValue, this.offsetValue + length);
        this.offsetValue += length;
        return str;
    }

    bufferSlice(): Buffer {
        return this.buffer.slice(0, this.offsetValue);
    }

    offset(): number {
        return this.offsetValue;
    }
}

function writePCBuffer(client: any, buffer: CustomBuffer) {
    const lengthBuffer = new CustomBuffer();
    lengthBuffer.writeletInt(buffer.bufferSlice().length);
    client.write(Buffer.concat([lengthBuffer.bufferSlice(), buffer.bufferSlice()]));
}

function ping(server: string, port: number, callback: any, timeout: number, protocol: number | string = '') {
    const start = new Date();
    const socket = net.connect({ port, host: server }, () => {
        const handshakeBuffer = new CustomBuffer();
        handshakeBuffer.writeletInt(0);
        handshakeBuffer.writeletInt(Number(protocol));
        handshakeBuffer.writeString(server);
        handshakeBuffer.writeUShort(port);
        handshakeBuffer.writeletInt(1);

        writePCBuffer(socket, handshakeBuffer);

        const setModeBuffer = new CustomBuffer();
        setModeBuffer.writeletInt(0);
        writePCBuffer(socket, setModeBuffer);
    });

    socket.setTimeout(timeout, () => {
        callback(new Error(`Socket timed out when connecting to ${server}:${port}`), null);
        socket.destroy();
    });

    let readingBuffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        readingBuffer = Buffer.concat([readingBuffer, data]);
        const buffer = new CustomBuffer(readingBuffer);

        let length: number;
        try { length = buffer.readletInt(); } catch { return; }
        if (readingBuffer.length < length - buffer.offset()) return;

        buffer.readletInt();

        try {
            const end = new Date();
            const json = JSON.parse(buffer.readString());
            callback(null, {
                error: false,
                ms: Math.round(end.getTime() - start.getTime()),
                version: json.version.name,
                playersConnect: json.players.online,
                playersMax: json.players.max
            });
        } catch (err) {
            callback(err, null);
        }

        socket.destroy();
    });

    socket.once('error', (err) => {
        callback(err, null);
        socket.destroy();
    });
}

class Status {
    ip: string;
    port: number;

    constructor(ip = '0.0.0.0', port = 25565) {
        this.ip = ip;
        this.port = port;
    }

    async getStatus() {
        return new Promise((resolve, reject) => {
            ping(this.ip, this.port, (err: any, res: unknown) => {
                if (err) return reject({ error: err });
                resolve(res);
            }, 3000);
        });
    }
}
export {
    MinecraftDownloader as MinecraftDownloader,
    MinecraftLauncher as MinecraftLauncher,
    MrpackExtractor as MrpackExtractor,
    CFModpackExtractor as CFModpackExtractor,
    Microsoft as Microsoft,
    NovaAZauth as NovaAZauth,
    Mojang as Mojang,
    Status as Status,
    MinecraftFolder as MinecraftFolder,
}
