/**
 * The vault container's durable object class: the owner's Obsidian vault,
 * held in continuous sync by obsidian-headless inside a Cloudflare Container,
 * fronted by the file API in `packages/vault-container/server.mjs`.
 *
 * One instance, addressed by a fixed name: the vault is the owner's and there
 * is one owner, the same singleton shape the deployment already has. The
 * gateway's vault route is the only caller; policy lives there, and this
 * class only carries requests to the container's port.
 *
 * The two secrets cross into the container as environment variables - the
 * account auth token, which the CLI reads from `OBSIDIAN_AUTH_TOKEN`
 * directly, and the per-vault sync config carrying the *derived* encryption
 * key, so the owner's end-to-end password never exists on Cloudflare at all.
 */
import { Container } from "@cloudflare/containers";

export interface VaultContainerBindings {
  readonly OBSIDIAN_AUTH_TOKEN: string;
  readonly OBSIDIAN_SYNC_CONFIG: string;
}

/** The container's API port; matches PORT in the image. */
const VAULT_PORT = 8788;

export class VaultContainer extends Container<VaultContainerBindings> {
  override defaultPort = VAULT_PORT;
  // The owner chose warm over cheap - the old VM this replaces cost two
  // orders of magnitude more - so the idle timeout is long. A cold wake is
  // not an error, just a ~20s initial sync; `VaultUnavailable` retries cover
  // it.
  override sleepAfter = "12h";

  // A class field, not a constructor: the base class yields a microtask
  // before reading instance configuration precisely so initializers like
  // these land first.
  override envVars = {
    OBSIDIAN_AUTH_TOKEN: this.env.OBSIDIAN_AUTH_TOKEN,
    OBSIDIAN_SYNC_CONFIG: this.env.OBSIDIAN_SYNC_CONFIG,
  };

  override fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, VAULT_PORT);
  }
}
