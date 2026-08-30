# Why an EasyCard can't be emulated by a third-party app

The short version is in the README. This is the long version, for anyone who
wants to check the reasoning rather than take it on faith — or who is about to
spend a weekend trying.

## The thing a gate actually asks for

An MRT gate doesn't read an identifier and look it up. EasyCard is an *offline
stored-value* system: the balance lives on the card, and the gate debits it
during the tap. That only works because the gate can prove the card is genuine.

EasyCard is MIFARE Classic. The card holds a set of 6-byte sector keys, and
access to a sector requires completing NXP's three-pass authentication with the
right key. Get it wrong and the card returns nothing.

So emulating a card means holding its keys and running that handshake. Three
things stand in the way, and each of them is independently fatal.

## Wall 1 — HCE can't emulate this card type

Android's Host Card Emulation is the only card-emulation API available to a
normal app. Its scope is ISO-DEP: ISO 14443-4 smartcards addressed with APDUs
and selected by AID.

MIFARE Classic is not ISO 14443-4. It stops at ISO 14443-3 and speaks NXP's own
proprietary command set on top. There is no AID to register, and no APDU
exchange to service. `HostApduService` has no representation for what a MIFARE
Classic reader sends.

This is a structural gap, not a missing permission. There is no flag to set.

## Wall 2 — the secure element is not yours to write to

The alternative is the embedded secure element (eSE), which *can* host a MIFARE
Classic applet. This is what Samsung Wallet uses.

Installing an applet there requires keys to the eSE's card manager, held by the
OEM and the TSM (Trusted Service Manager) under GSMA rules. An app can't install
an applet; the issuer's own TSM does it, for hardware the issuer has certified.

Android's `OMAPI` (`android.se.omapi`) lets a *privileged* app talk to applets
that are already installed, gated by an access rule on the element itself. It
does not let you put one there.

## Wall 3 — the keys

Even granting walls 1 and 2 away, an emulated card still has to answer the
gate's challenge, and that needs EasyCard Corporation's keys.

These are not published, and there is no programme that issues them to
developers. Obtaining them by attacking the protocol crosses from "reading a
card I own" into forging a payment instrument — which is the line this project
does not go near, and the reason there is no write path in the code.

## What Samsung Wallet actually is

Not a technical bypass — a commercial agreement. EasyCard Corp certified
specific Samsung hardware, and provisions card credentials into that eSE through
Samsung's TSM. The clever part is the contract and the certification, not the
NFC.

An independent developer cannot reproduce any leg of it.

## What is left, and why it's worth building

Reading. It requires no privileged access, no issuer relationship, no keys
beyond the ones for a card you already own — and it answers the question people
actually open a wallet app for: *how much is on this card, and where did it go?*

That is what this app does.

## Sources worth reading

- Android HCE documentation, "Non-ISO-DEP protocols" —
  https://developer.android.com/develop/connectivity/nfc/hce
- `android.nfc.tech.MifareClassic`, on hardware support varying by chipset —
  https://developer.android.com/reference/android/nfc/tech/MifareClassic
- `android.se.omapi`, the read-only door to already-provisioned applets —
  https://developer.android.com/reference/android/se/omapi/package-summary
- GlobalPlatform Card Specification, on who may install applets to a secure
  element.
- Metrodroid, the open-source transit-card reader that supports EasyCard —
  https://github.com/metrodroid/metrodroid
