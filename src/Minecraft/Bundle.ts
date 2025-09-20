import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { getFileHash } from '../Utils/Index.js';

export interface BundleItem {
  type?: 'CFILE' | 'Assets' | string;
  path: string;
  folder?: string;
  content?: string;
  sha1?: string;
  size?: number;
  url?: string;
}

export interface MinecraftBundleOptions {
  path: string;
  instance?: string;
  ignored: string[];
}

export default class MinecraftBundle extends EventEmitter {
  private options: MinecraftBundleOptions;

  constructor(options: MinecraftBundleOptions) {
    super();
    this.options = options;
  }

  /**
   * Intenta leer un bundle.json desde varias ubicaciones (root/bundle.json,
   * root/resources/bundle.json, root/instances/<inst>/bundle.json).
   * Retorna [] si no existe o falla el parseo.
   */
  public async getAll(): Promise<BundleItem[]> {
    const candidates = [
      path.join(this.options.path, 'bundle.json'),
      path.join(this.options.path, 'resources', 'bundle.json'),
    ];
    if (this.options.instance) {
      candidates.unshift(path.join(this.options.path, 'instances', this.options.instance, 'bundle.json'));
    }

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const raw = await fs.promises.readFile(p, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed as BundleItem[];
          } else if (Array.isArray(parsed.files)) {
            return parsed.files as BundleItem[];
          }
        } catch (e) {
          // si falla parseo, seguir intentando otras rutas
          this.emit('warn', `[Bundle] Error parseando ${p}: ${String((e as Error).message)}`);
        }
      }
    }

    // si no hay bundle, retornar vacío
    return [];
  }

  /**
   * Alias más semántico para frameworks que esperan "listAll"
   */
  public async listAll(): Promise<BundleItem[]> {
    return this.getAll();
  }

  /**
   * Resuelve rutas absolutas para cada BundleItem y rellena folder.
   * Si se le pasa bundle (opcional) lo normaliza, sino intenta leer con getAll().
   */
  public async getBundle(bundle?: BundleItem[]): Promise<BundleItem[]> {
    const items = bundle ?? (await this.getAll());
    return this.resolveBundlePaths(items);
  }

  /**
   * Comprueba el bundle y devuelve los archivos que hacen falta o que no coinciden (sha1/size).
   * Acepta tanto BundleItem[] con paths relativos como absolutos.
   */
  public async checkBundle(bundle: BundleItem[]): Promise<BundleItem[]> {
    const toDownload: BundleItem[] = [];
    const normalized = await this.resolveBundlePaths(bundle);

    for (let i = 0; i < normalized.length; i++) {
      const file = normalized[i];
      if (!file?.path) continue;

      if (file.type === 'CFILE') {
        // crear archivo CFILE si es necesario (se sobrescribe siempre con content)
        try {
          await this.#writeCFile(file);
        } catch (e) {
          this.emit('warn', `[Bundle] Error escribiendo CFILE ${file.path}: ${(e as Error).message}`);
        }
        this.emitProgress(file, i, normalized.length);
        continue;
      }

      const exists = fs.existsSync(file.path);
      const ignored = this.#shouldIgnore(file.path);
      let hashMatches = true;
      let sizeMatches = true;

      if (exists && !ignored) {
        if (file.sha1) {
          try {
            const currentHash = await getFileHash(file.path);
            hashMatches = currentHash === file.sha1;
          } catch {
            hashMatches = false;
          }
        }
        if (file.size) {
          try {
            const stats = fs.statSync(file.path);
            sizeMatches = stats.size === file.size;
          } catch {
            sizeMatches = false;
          }
        }
      }

      if (!exists || !hashMatches || !sizeMatches) {
        toDownload.push(file);
      }

      this.emitProgress(file, i, normalized.length);
    }

    return toDownload;
  }

  /**
   * Retorna el tamaño total (sum of sizes) del bundle, útil para estimar descarga.
   */
  public async getTotalSize(bundle: BundleItem[]): Promise<number> {
    return bundle.reduce((acc, f) => acc + (f.size ?? 0), 0);
  }

  /**
   * Limpia archivos no permitidos dentro de la instancia/base (lo tenías antes).
   */
  public async checkFiles(bundle: BundleItem[]): Promise<void> {
    const instancePath = this.options.instance ? path.join('instances', this.options.instance) : '';
    const basePath = path.join(this.options.path, instancePath);
    const allFiles = this.getFiles(basePath);

    const allowed = new Set<string>([
      ...this.getFiles(path.join(this.options.path, 'loader')),
      ...this.getFiles(path.join(this.options.path, 'runtime')),
      ...bundle.map(f => path.resolve(this.options.path, f.path)),
      ...this.options.ignored.map(f => path.join(basePath, f)),
    ]);

    for (const filePath of allFiles) {
      if (!allowed.has(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          if (stats.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
            this.#cleanupEmptyDirs(filePath, basePath);
          }
        } catch {
          // ignorar errores
        }
      }
    }
  }

  /**
   * Normaliza las rutas de BundleItem a rutas absolutas y asegura folder.
   */
  public async resolveBundlePaths(items: BundleItem[]): Promise<BundleItem[]> {
    const resolved: BundleItem[] = [];
    for (const item of items) {
      const copy: BundleItem = { ...item };
      // if path is absolute, keep it, otherwise resolve relative to options.path (and instance if set)
      let candidate = copy.path || '';
      // Si el path ya está absoluto, lo usamos; sino lo resolvemos relativo a root o instance
      if (!path.isAbsolute(candidate)) {
        // Primero tratar como relativo a la instancia si existe y ese archivo existe
        const tryInstance = this.options.instance ? path.resolve(this.options.path, 'instances', this.options.instance, candidate) : null;
        const tryRoot = path.resolve(this.options.path, candidate);
        if (tryInstance && fs.existsSync(tryInstance)) candidate = tryInstance;
        else candidate = tryRoot;
      }
      // Normalizar separadores a sistema y a unix-style en property .path para compatibilidad
      copy.path = candidate;
      copy.folder = copy.folder ?? path.dirname(copy.path);
      resolved.push(copy);
    }
    return resolved;
  }

  /**
   * Obtiene recursivamente todos los archivos dentro de un directorio.
   * Retorna rutas absolutas.
   */
  public getFiles(dirPath: string, collected: string[] = []): string[] {
    if (!fs.existsSync(dirPath)) return collected;
    for (const entry of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, entry);
      const stats = fs.statSync(full);
      if (stats.isDirectory()) this.getFiles(full, collected);
      else collected.push(full);
    }
    return collected;
  }

  async #writeCFile(file: BundleItem) {
    const folder = file.folder ?? path.dirname(file.path ?? '');
    const filePath = file.path ?? '';
    if (!filePath) throw new Error('BundleItem.path no puede ser undefined para CFILE');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true, mode: 0o777 });
    fs.writeFileSync(filePath, file.content ?? '', { encoding: 'utf8', mode: 0o755 });
  }

  #shouldIgnore(filePath: string): boolean {
    const prefix = this.options.instance
      ? path.join(this.options.path, 'instances', this.options.instance)
      : this.options.path;
    const rel = path.relative(prefix, filePath).replace(/\\/g, '/');
    return this.options.ignored.includes(rel);
  }

  #cleanupEmptyDirs(filePath: string, basePath: string) {
    let current = path.dirname(filePath);
    while (current.startsWith(basePath) && current !== basePath) {
      if (fs.existsSync(current) && fs.readdirSync(current).length === 0) {
        fs.rmdirSync(current);
      }
      current = path.dirname(current);
    }
  }

  private emitProgress(file: BundleItem, index: number, total: number) {
    this.emit('progress', {
      filePath: file.path,
      type: file.type,
      currentIndex: index + 1,
      totalFiles: total,
      percent: Number(((index + 1) / total * 100).toFixed(2))
    });
  }
}
