import type * as vscode from 'vscode';
import type { SecretStore } from '../../application/ports';
import type { ConnectionId } from '../../domain/model';

/** SecretStore on VS Code's encrypted SecretStorage, with a per-profile key index so deleteAll works. */
export class VsCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(id: ConnectionId, k: string) { return `betterSqlTools/${id}/${k}`; }
  private index(id: ConnectionId) { return `betterSqlTools/${id}/__keys`; }

  async storedKeys(id: ConnectionId): Promise<string[]> {
    try {
      const parsed = JSON.parse((await this.secrets.get(this.index(id))) ?? '[]');
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  async get(id: ConnectionId, key: string) {
    return this.secrets.get(this.key(id, key));
  }

  async set(id: ConnectionId, key: string, value: string) {
    await this.secrets.store(this.key(id, key), value);
    const keys = await this.storedKeys(id);
    if (!keys.includes(key)) await this.secrets.store(this.index(id), JSON.stringify([...keys, key]));
  }

  async deleteAll(id: ConnectionId) {
    for (const k of await this.storedKeys(id)) await this.secrets.delete(this.key(id, k));
    await this.secrets.delete(this.index(id));
  }
}
