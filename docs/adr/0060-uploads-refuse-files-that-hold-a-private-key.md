# 0060: Uploads refuse a file that holds a private key, whatever its name

**Status:** Accepted, 2026-11-14. Extends [0012](0012-upload-path-policy.md).

## Context

ADR 0012 refuses key files by name only and accepts that a key with a plain name is read. The
default upload folders are the folder the MCP client started Foxleash in and `~/Downloads`, so
with no configuration at all an agent steered by a page could upload a Google service account
key (`serviceAccountKey.json`, which projects keep in their folder and whose JSON holds a PEM
private key mid-file), an SSH key named `deploy`, an age identity in `key.txt` (the name age's
own documentation uses), or a kubeconfig in `~/Downloads` whose `client-key-data` is a PEM key
encoded as base64.

Some key files are recognised only by name. Kerberos credential caches sit in `/tmp`, which is
an upload folder when the client starts there; a keytab holds a principal's long-term keys; a
KeePass database holds all its owner's passwords. All three are binary.

This record quotes the markers below, so uploading it is refused too; that is one of the
consequences.

## Decision

`readOpened` in `apps/server/src/upload-policy.ts` refuses a file whose bytes hold any of these
markers (`PRIVATE_KEY_MARKERS`), each text that only a private key's own file format holds:

- `PRIVATE KEY-----`: every PEM private key header and footer (PKCS#1, PKCS#8 also encrypted,
  SEC1, OpenSSH), also inside a JSON string as in a service account key.
- `PRIVATE KEY BLOCK-----`: an armored OpenPGP secret key.
- `PRIVATE KEY ----`: an SSH2 private key as ssh.com and PuTTYgen write it.
- `PuTTY-User-Key-File-`: the first line of a PuTTY `.ppk` key.
- `AGE-SECRET-KEY-`: an age identity, the post-quantum one included.
- `openssh-key-v1` followed by a NUL byte: the start of every OpenSSH private key's binary
  body, so a key with its BEGIN and END lines removed, as base64 or decoded, is caught.

The match is case-sensitive, on the raw bytes with `Buffer.prototype.includes`, and also on
each marker's three base64 forms (`base64Forms`): base64 maps 3 bytes to 4 characters, so the
encoding depends on where the marker starts in a 3-byte group, and each form is the encoding
of the whole groups the marker fills after skipping 0, 1 or 2 of its bytes. The forms hold only
letters and digits, so they match base64url too.

The check (`holdsPrivateKey`) runs on the bytes read from the open descriptor, after the whole
read and the one-byte read past its end, so after every existing check, whose reasons stand: a
file swapped between the path checks and the read is judged by what was read. Its refusal is
"holds a private key; Foxleash never uploads those." and names no bytes.

By name, `kdbx` and `keytab` join the key extensions, with the existing handling (any part
after the first, a trailing `~` removed, any case), and a name that starts with `krb5cc` in any
case is key-shaped (`krb5cc_<uid>`, `krb5cc_<uid>_<random>`, a copy named `krb5cc`).

## Alternatives rejected

- Refusing `*.asc` by name: such a file is as often a public key or a signature, and an armored
  secret key is caught by its content.
- A regular expression over decoded text: it would decode up to 10 MB per call for no gain over
  a byte search.
- Checking only the first bytes: a service account key or a kubeconfig has its key mid-file.
- Matching `PRIVATE KEY` alone, or ignoring case: it refuses prose about keys. The dashes
  belong to the formats, and PEM labels are upper case.
- Recognising binary key formats by their signatures: one rule per format, for files whose
  names already identify them.

## Consequences

- A file that merely quotes a marker is refused: documentation of a key format, a test fixture,
  a program that handles keys (`ssh`, `ssh-keygen`, `gpg`), this record.
- Not detected: keys inside compressed files or archives (`.zip`, `.gz`, `.docx`); binary keys
  (DER, PKCS#12 or JKS under another name, a GPG export that is not armored); KeePass
  databases, Kerberos caches and keytabs under other names; UTF-16 text; base64 broken across
  lines (as in an email attachment) where a break falls inside a marker; base64 nested in base64
  (a kubeconfig stored in a Kubernetes Secret); hex, URL or form encoding (a key posted in a
  form, in a HAR export), or JSON `\u` escapes; and keys stored without any marker (a bare
  PKCS#1 or PKCS#8 base64 body in a configuration value, a WireGuard `PrivateKey =`, a JSON Web
  Key). Other names stay as 0012 lists them.
- The search costs a few tens of milliseconds per 10 MB call.
