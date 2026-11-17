# 0074: Uploads refuse a file that starts with a binary OpenPGP secret key

**Status:** Accepted, 2026-11-17. Extends [0060](0060-uploads-refuse-files-that-hold-a-private-key.md).

## Context

gpg writes a secret key export in binary unless it is asked for armour, so
`gpg --export-secret-keys > backup.gpg` gives a file with none of the text markers 0060 looks
for. 0060 lists "a GPG export that is not armored" as not detected, while `docs/security.md`, the
add-on listing and the `upload_file` description say that a file holding a PGP private key is
refused.

Exports made for the purpose with gpg 2.4 and throwaway keys start with an old-format Secret-Key
packet header (tag 5):

| export | first bytes |
|---|---|
| `--export-secret-keys`, Ed25519 with a Cv25519 subkey | `94 58 04 6a ...` |
| `--export-secret-keys`, RSA-3072 | `95 05 58 04 ...` |
| `--export-secret-subkeys`, Ed25519 | `94 3b 04 6a ...` (a stub primary key, still tag 5) |
| `gpgsplit` of the Ed25519 export, the subkey's file | `9c 5d 04 6a ...` (Secret-Subkey, tag 7) |
| `--export`, the public key | `98 33 04 6a ...` (tag 6) |
| `-e -r`, a file encrypted to the key | `84 5e 03 ...` (tag 1) |
| `-c`, a file encrypted with a passphrase | `8c 0d 04 ...` (tag 3) |

## Decision

`holdsPrivateKey` in `apps/server/src/upload-policy.ts` also refuses a file for which
`startsWithSecretKeyPacket` holds, so the refusal reads "holds a private key" as before. The file
must start with an OpenPGP packet header (RFC 9580 section 4.2) of tag 5 (Secret-Key) or 7
(Secret-Subkey), in the old format (`0x94` to `0x96`, `0x9C` to `0x9E`) or the new one (`0xC5`,
`0xC7`), with a definite body length of at least 40 bytes that fits in the file, and the body's
first byte, the key version, must be 2 to 6. Indeterminate (`0x97`, `0x9F`) and partial lengths do
not match. No algorithm is checked. Only the packet at the file's start is checked.

The 40-byte floor: the smallest secret key packet measured is 59 bytes (the stub primary key of
`--export-secret-subkeys`), and below it is where small binary data matches. MessagePack uses the
same header bytes for arrays, and `94 01 02 03 04`, the array `[1,2,3,4]`, would read as a
Secret-Key packet of version 2 with a floor of 1 byte. Tag 7 counts because a Secret-Subkey packet
on its own, as `gpgsplit` writes it, holds a private key. Version 2 counts because GnuPG still
reads PGP 2.x keys, which have the same format as version 3.

By name, `keyShaped` refuses a name that starts with `secring` (the secret keyrings of GnuPG 1.x,
PGP 2.x and PGP Desktop, with any extension or backup suffix), and `KEY_EXTENSIONS` has `skr`
(PGP Desktop's secret keyring).

Under 0072's rule for a fix to a safeguard that runs in the server, `PROTOCOL_VERSION` is 7, and
the step from 6 in `apps/extension/src/served-protocols.ts` refuses `upload_chunk` and
`upload_file` with `protocol_mismatch` and a sentence naming the update command; every other
request from 6 is served unchanged. The check runs in the MCP server (`sendUpload` in
`apps/server/src/tools.ts` reads through `upload-policy.ts`), while the extension chooses the
step by the host's protocol. The step reaches an old MCP server only because the MCP server and
the host stay exact with each other (0072; the host refuses a peer of another protocol in
`greetPeer` and in its request refusal in `apps/server/src/host.ts`). If a later change opens a
window between those two, it must keep refusing uploads from an MCP server older than 7.

## Alternatives rejected

- Refusing `*.gpg` by name: encrypted files and public keyrings use it.
- Searching the whole file for packet headers: any binary would match somewhere.
- Following the packets from the start by their declared lengths, to find a secret key packet
  after a public key or other OpenPGP data. No exporter we know of writes a secret key after other
  packets: such a file is made by concatenating exports by hand
  (`gpg --export K > f; gpg --export-secret-keys K >> f`), and every packet followed is one more
  place where bytes that are not OpenPGP but happen to frame as packets lead to a refusal.
  Revisit if a tool is found that writes one.
- A body floor of 1 byte: MessagePack data matches.
- Checking algorithm ids: keys of new algorithms would be read.
- Only tag 5: a subkey split out by `gpgsplit` holds a private key.
- Changing only the documentation: the listing's claim is the promise users read.

## Consequences

- Not detected: a binary secret key that does not start the file (after other data, such as a
  public export with the secret export appended, or inside an archive); the base64 of a binary
  export without armour lines; an old-format header of indeterminate length (`0x97`, `0x9F`),
  which no exporter writes for keys; a packet cut short (its declared length past the file's end);
  a key version above 6 until one is defined (revisit then); GnuPG's own key store files
  (`private-keys-v1.d/*.key`), refused by their `.key` name only.
- A file whose first bytes happen to form such a header (tag 5 or 7, a length of at least 40
  that fits, a version byte of 2 to 6) is refused. MessagePack and CBOR data can, for example a
  MessagePack array whose first element is 40 to 127 and second 2 to 6, or a top-level
  MessagePack bin16 of 10,240 bytes or more.
- An extension that updated before the program refuses that program's uploads, with a sentence
  naming the update command, until the user updates the program; every other tool keeps working.
