/**
 * The credential store: get, put, list, and the cipher they stand on.
 *
 * Encrypt and decrypt live here, inside the store module in the vault, so
 * storage holds only ciphertext and `list` returns only metadata. AES-256-GCM
 * with a 12-byte random IV, the key derived per purpose from one
 * `CREDENTIAL_KEY` worker secret, AAD `opti.v1|credential-store|owner:{id}`.
 *
 * The AAD binds owner and purpose and deliberately not the credential name:
 * the named threat is a ciphertext moved into another owner's place, and an
 * attacker rearranging rows inside an owner's own vault is that owner.
 *
 * The ciphertext format is versioned from day one, `v1.<iv>.<ciphertext>` in
 * base64url, because kody had to retrofit exactly this when it added AAD to
 * existing rows.
 */
import { Data, Effect } from "effect";
import type { Failure } from "../kernel/index.ts";

const VERSION = "v1";
const PURPOSE = "credential-store";

/**
 * The row would not decrypt. Deliberately one tag for every cause - wrong
 * owner, tampering, an unknown version - because distinguishing them for a
 * caller would also distinguish them for whoever moved the row.
 */
export class DecryptFailed extends Data.TaggedError("DecryptFailed")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));

/**
 * One secret, a key per purpose: HKDF-SHA256 with the purpose in the info,
 * so the day a second purpose exists its keys are already not this one.
 */
const deriveKey = async (secret: string, purpose: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(`opti.${VERSION}|${purpose}`) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const additionalData = (ownerId: string): Uint8Array => encoder.encode(`opti.${VERSION}|${PURPOSE}|owner:${ownerId}`);

export const encrypt = (secret: string, ownerId: string, plaintext: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await deriveKey(secret, PURPOSE);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(ownerId) },
      key,
      encoder.encode(plaintext),
    );
    return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
  });

export const decrypt = (secret: string, ownerId: string, stored: string): Effect.Effect<string, DecryptFailed> =>
  Effect.gen(function* () {
    const [version, encodedIv, encodedCiphertext, ...rest] = stored.split(".");
    if (version !== VERSION || encodedIv === undefined || encodedCiphertext === undefined || rest.length > 0) {
      return yield* new DecryptFailed({ message: `this is not a ${VERSION} ciphertext` });
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const key = await deriveKey(secret, PURPOSE);
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromBase64Url(encodedIv), additionalData: additionalData(ownerId) },
          key,
          fromBase64Url(encodedCiphertext),
        );
        return decoder.decode(plaintext);
      },
      // The message names the invariant, not the cause: see the class doc.
      catch: () => new DecryptFailed({ message: "the row would not decrypt for this owner" }),
    });
  });
