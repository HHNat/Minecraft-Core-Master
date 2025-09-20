/**
 * @author NovaStepStudios
 * @alias StepnickaSantiago
 * @license Apache-2.0
 * @link https://www.apache.org/licenses/LICENSE-2.0
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

export async function fromURL(
  url: string,
  destination: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.promises.mkdir(path.dirname(destination), { recursive: true })
      .then(() => {
        const file = fs.createWriteStream(destination);

        https.get(url, (res) => {
          if (res.statusCode !== 200) {
            file.close();
            return reject(new Error(`Error al descargar: HTTP ${res.statusCode} -> ${url}`));
          }

          const totalSize = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress) onProgress(downloaded, totalSize);
          });

          res.pipe(file);

          file.on('finish', () => {
            file.close();
            resolve();
          });

          file.on('error', (err) => {
            if (file) file.close();
            fs.unlink(destination, () => reject(err));
          });

        }).on('error', (err) => {
          fs.unlink(destination, () => reject(err));
        });
      })
      .catch(reject);
  });
}

export async function downloadJSON<T = any>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} -> ${url}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

export class TaskLimiter {
  private concurrency: number;
  private running: number = 0;
  private queue: Array<() => void> = [];
  constructor(concurrency: number) {
    if (concurrency < 1) {
      throw new Error('La concurrencia debe ser al menos 1');
    }
    this.concurrency = concurrency;
  }

  public limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        this.running++;
        Promise.resolve(fn())
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.running--;
            this.dequeue();
          });
      };
      if (this.running < this.concurrency) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  private dequeue(): void {
    if (this.queue.length > 0 && this.running < this.concurrency) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export function createTaskLimiter(concurrency: number): TaskLimiter {
  return new TaskLimiter(concurrency);
}