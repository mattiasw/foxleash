# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub's private vulnerability reporting: open the
[Security tab of the repository](https://github.com/mattiasw/foxleash/security), choose
"Report a vulnerability", or go straight to
<https://github.com/mattiasw/foxleash/security/advisories/new>.

Never report a vulnerability in a public issue, pull request or discussion.

Please include:

- the Foxleash version, both the add-on and the program
- your Firefox version and operating system
- the steps to reproduce it
- what an attacker gains

## Supported versions

Only the latest release is supported. A fix comes in a new release.

## What counts as a vulnerability

Foxleash acts in your logged-in Firefox, so a way around one of the safeguards described in
[docs/security.md](docs/security.md) is a vulnerability. An example is a web page that gets the
agent to act on a site you did not approve.
