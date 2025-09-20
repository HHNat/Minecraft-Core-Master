/**
 * @author NovaStepStudios
 * @alias StepnickaSantiago
 * @license Apache-2.0
 * @link https://www.apache.org/licenses/LICENSE-2.0    
 */

import fs, { createReadStream, createWriteStream, mkdirSync, existsSync, PathLike } from 'fs';
import { EventEmitter } from 'events';
import { dirname, join } from 'path';
import { pipeline, Readable } from 'stream';
import { promisify } from 'util';
import * as zlib from 'zlib';
const pipelineAsync = promisify(pipeline);

interface ZipEntry {
  filename: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize?: number;
  crc32?: number;
  offset: number;
  externalFileAttr: number;
  comment?: string;
  isDirectory?: boolean;
}
export interface SimpleZipEntry {
  entryName: string;
  isDirectory: boolean;
  getData: () => Buffer;
}

export class NativeExtractor extends EventEmitter {
  zipPath: PathLike;

  constructor(zipPath: PathLike) {
    super();
    this.zipPath = zipPath;
    if (!existsSync(zipPath)) throw new Error(`Archivo ZIP no encontrado: ${zipPath}`);
  }

  async extractAllTo(targetPath: string, overwrite = true, keepStructure = true) {
    const entries = await this.getEntries();
    let total = entries.length, current = 0;

    for (const entry of entries) {
      await this.extractEntry(entry, targetPath, overwrite, keepStructure);
      current++;
      const percent = Math.round((current / total) * 100);
      this.emit('progress', { current, total, percent, file: entry.filename });
    }
    this.emit('close');
  }

  async extractNatives(targetPath: string, overwrite = true) {
    const entries = await this.getEntries();
    let total = entries.length, current = 0;

    for (const entry of entries) {
      if (entry.filename.includes('natives')) {
        await this.extractEntry(entry, targetPath, overwrite, true);
        current++;
        const percent = Math.round((current / total) * 100);
        this.emit('progress', { current, total, percent, file: entry.filename });
      }
    }
    this.emit('close');
  }

  async extractEntry(entry: ZipEntry, targetPath: string, overwrite: boolean, keepStructure: boolean) {
    if (entry.isDirectory) return;

    const outputPath = keepStructure
      ? join(targetPath, ...entry.filename.split('/'))
      : join(targetPath, entry.filename.split('/').pop() || entry.filename);

    mkdirSync(dirname(outputPath), { recursive: true });
    if (!overwrite && existsSync(outputPath)) return;

    const readStream = createReadStream(this.zipPath, {
      start: entry.offset,
      end: entry.offset + entry.compressedSize - 1
    });

    let decompressStream: NodeJS.ReadableStream;
    switch (entry.compressionMethod) {
      case 0:
        decompressStream = readStream;
        break;
      case 8:
        decompressStream = readStream.pipe(zlib.createInflateRaw());
        break;
      case 9:
        console.warn(`[WARN] Deflate64 no soportado, usando Deflate para: ${entry.filename}`);
        decompressStream = readStream.pipe(zlib.createInflateRaw());
        break;
      default:
        throw new Error(`Método de compresión no soportado: ${entry.compressionMethod} en ${entry.filename}`);
    }

    try {
      await pipelineAsync(decompressStream, createWriteStream(outputPath));
      if (process.platform !== 'win32') {
        await fs.promises.chmod(outputPath, 0o755);
      }
    } catch (err: any) {
      this.emit('error', { file: entry.filename, error: err });
    }
  }

  async getEntries(): Promise<ZipEntry[]> {
    const buffer = await fs.promises.readFile(this.zipPath);
    const entries: ZipEntry[] = [];
    const fileSize = buffer.length;

    let eocdOffset = -1;
    for (let i = fileSize - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error('Archivo ZIP inválido: No se encontró Central Directory');

    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    let cdOffsetCurrent = cdOffset;

    while (cdOffsetCurrent < eocdOffset) {
      if (buffer.readUInt32LE(cdOffsetCurrent) !== 0x02014b50) break;

      const compressionMethod = buffer.readUInt16LE(cdOffsetCurrent + 10);
      const compressedSize = buffer.readUInt32LE(cdOffsetCurrent + 20);
      const uncompressedSize = buffer.readUInt32LE(cdOffsetCurrent + 24);
      const fileNameLength = buffer.readUInt16LE(cdOffsetCurrent + 28);
      const extraFieldLength = buffer.readUInt16LE(cdOffsetCurrent + 30);
      const fileCommentLength = buffer.readUInt16LE(cdOffsetCurrent + 32);
      const externalFileAttr = buffer.readUInt32LE(cdOffsetCurrent + 38);
      const relativeOffsetLocalHeader = buffer.readUInt32LE(cdOffsetCurrent + 42);

      const filenameStart = cdOffsetCurrent + 46;
      const filename = buffer.toString('utf8', filenameStart, filenameStart + fileNameLength);

      const lfhBuffer = buffer.slice(relativeOffsetLocalHeader);
      if (lfhBuffer.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Local File Header inválido para: ${filename}`);
      }
      const lfhFileNameLength = lfhBuffer.readUInt16LE(26);
      const lfhExtraFieldLength = lfhBuffer.readUInt16LE(28);
      const dataOffset = relativeOffsetLocalHeader + 30 + lfhFileNameLength + lfhExtraFieldLength;

      entries.push({
        filename,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        offset: dataOffset,
        externalFileAttr,
        comment: '',
        isDirectory: filename.endsWith('/')
      });

      cdOffsetCurrent += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }

    return entries;
  }

  parse() {
    const parser = new EventEmitter();
    this.getEntries().then(entries => {
      entries.forEach(entry => {
        if (entry.isDirectory) return;

        const fileStream = createReadStream(this.zipPath, {
          start: entry.offset,
          end: entry.offset + entry.compressedSize - 1
        });

        let decompressStream: NodeJS.ReadableStream;
        switch (entry.compressionMethod) {
          case 0:
            decompressStream = fileStream;
            break;
          case 8:
            decompressStream = fileStream.pipe(zlib.createInflateRaw());
            break;
          default:
            return;
        }

        const entryStream = decompressStream as Readable & { path: string; autodrain: () => void };
        entryStream.path = entry.filename;
        entryStream.autodrain = () => entryStream.resume();

        parser.emit("entry", entryStream);
      });
      parser.emit("close");
    }).catch(err => {
      parser.emit("error", err);
    });

    return parser;
  }
}

// ---------------------- Unzipper para buffers ----------------------

export class Unzipper {
  private entries: SimpleZipEntry[] = [];
  constructor(zipFilePath: string) {
    const buffer = fs.readFileSync(zipFilePath);
    this.parseBuffer(buffer);
  }

  private parseBuffer(buffer: Buffer) {
    const LFH_SIG = 0x04034b50;
    let offset = 0;

    while (offset < buffer.length - 4) {
      const sig = buffer.readUInt32LE(offset);
      if (sig !== LFH_SIG) { offset++; continue; }

      try {
        const compressionMethod = buffer.readUInt16LE(offset + 8);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const fileNameLength = buffer.readUInt16LE(offset + 26);
        const extraFieldLength = buffer.readUInt16LE(offset + 28);
        const fileNameStart = offset + 30;
        const fileNameEnd = fileNameStart + fileNameLength;
        const fileName = buffer.toString('utf-8', fileNameStart, fileNameEnd);

        const dataStart = fileNameEnd + extraFieldLength;
        const dataEnd = dataStart + compressedSize;
        const compressedData = buffer.slice(dataStart, dataEnd);

        this.entries.push({
          entryName: fileName,
          isDirectory: fileName.endsWith('/'),
          getData: () => {
            if (compressionMethod === 0) return compressedData;
            if (compressionMethod === 8) return zlib.inflateRawSync(compressedData);
            throw new Error(`Unsupported compression method: ${compressionMethod} for file ${fileName}`);
          }
        });

        offset = dataEnd;
      } catch (err) {
        console.warn('Error parsing zip entry, skipping...', err);
        offset += 4;
      }
    }
  }

  getEntries(): SimpleZipEntry[] { return this.entries; }
  getEntry(name: string): SimpleZipEntry | undefined { return this.entries.find(e => e.entryName === name); }
  getEntriesWithPrefix(prefix: string): SimpleZipEntry[] { return this.entries.filter(e => e.entryName.startsWith(prefix)); }
  getFiles(): SimpleZipEntry[] { return this.entries.filter(e => !e.isDirectory); }
  getDirectories(): SimpleZipEntry[] { return this.entries.filter(e => e.isDirectory); }
  count(): number { return this.entries.length; }
}
