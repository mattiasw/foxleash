# 0104: The manifest declares three data categories

**Status:** Accepted, 2026-11-21.

## Context

Mozilla's Extension Workshop page "Firefox built-in consent for data collection and
transmission" says that "data collection information is presented to the user in the installation
prompt", and that "When an extension is updated, Firefox only shows the added required data
permissions". A required category added after the add-on is listed reaches every existing user as
a new prompt, so the set has to be right before the listing goes up.

When the agent asks for it, the extension sends this to the local program, which passes it to the
agent: page text and structure, form fields, screenshots, console messages, the network requests a
page makes (URLs, methods, resource types, status, timing, errors, headers, and the field names and
value kinds of what a request sent, never the values) and the text of responses; the URLs and
titles of the agent's tabs on approved sites, the site address of its other tabs, and where
navigations end. Much of this can carry sign-in details. The listing's Data collection and
handling section says the same at length.

The page defines the categories this way:

- `websiteContent`: "Covers anything visible on a website", such as text, images, videos and
  links, and "anything embedded, such as cookies, audio, page headers, and request and response
  information".
- `browsingActivity`: "Information about the websites users visit, such as specific URLs,
  domains, or categories of pages users view."
- `authenticationInfo`: "Examples: passwords, usernames, personal identification numbers (PINs),
  security questions, and registration information for extensions that offer account-based
  services."
- `personalCommunications`: "Examples: emails, text or chat messages, social media posts, and
  data from phone calls and conference calls."
- `personallyIdentifyingInfo`: "Examples: contact information such as name and address, email,
  and phone number, as well as other identifying data such as ID numbers, voice or video
  recordings, age, demographic information, or biometric data."

## Decision

The `data_collection_permissions` key of `apps/extension/manifest.json` declares three required
categories, `websiteContent`, `browsingActivity` and `authenticationInfo`, and no optional one.
The list after "The extension declares these kinds of data to Firefox:" in
`docs/amo/listing.md` names the same three.

`personalCommunications` and `personallyIdentifyingInfo` are not declared. Foxleash reaches a
person's mail, messages or contact details only through what a page shows or loads: an email in a
webmail page, a name on a profile page, the network response a page's script received them in.
`websiteContent` covers both: what is visible on a website, and the request and response
information embedded in it.

`authenticationInfo` is declared although `websiteContent` and `browsingActivity` cover the pages,
addresses and requests that carry sign-in data, because that data lets whoever holds it act as the
user, and Foxleash cannot keep all of it from the agent. It redacts the Cookie, Set-Cookie,
Authorization and Proxy-Authorization headers
([0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md)) and withholds
the values of password fields ([0010](0010-page-tools-withhold-credential-field-values.md)), but
tokens and account details still reach the agent in addresses, other headers, request field names,
response text and console messages.

## Alternatives rejected

- Declaring `personalCommunications` and `personallyIdentifyingInfo` "to be safe", or likewise
  `healthInfo` and `financialAndPaymentInfo`. Any page can show any kind of data, so the same
  reasoning would add every category, and the declaration would say nothing.
- Declaring `websiteActivity` or `searchTerms`. Foxleash sends no record of the user's own
  scrolling, clicks or typing: the clicks and typing in its results are the agent's. A search the
  user made reaches the agent only as a tab's address or what its page shows, which
  `browsingActivity` and `websiteContent` cover.
- Declaring `none`. Foxleash does send website content, browsing activity and data that can carry
  sign-in details to the local program.
- Making a category optional. Nothing Foxleash sends is optional per category, and its tools need
  all three.

## Consequences

A feature that sends data that none of the three declared categories covers, as Mozilla defines
them above, needs a new category, which existing users see at the update. That is a decision and
a listing change, never a routine edit. [0035](0035-recipes-saved-and-run-only-by-a-user-click.md)
records the decision that recipes add no category.

The release check guards the declaration in `bin/check-release.ts`. `checkListingDrift` fails when
the manifest's `data_collection_permissions` changed since the last release tag but the listing's
Summary, Description, Permissions and Data collection and handling sections did not.
`checkPermissionsExplained` fails when a declared category is not named as `(name)` in the Data
collection and handling section; neither check fails when the listing names a category the
manifest does not declare. If Mozilla changes a definition above so that `websiteContent`
no longer covers what a page shows or loads, this decision is revisited.
