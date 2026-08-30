# EasyWallet

An Android wallet app for Taiwan's EasyCard (悠遊卡). It reads your card over NFC
and keeps balance and transaction history for as many cards as you like.

**It does not pay.** Please read the next section before anything else.

---

## Can this replace tapping my physical card?

No — and no third-party app can. This is worth explaining properly, because it's
the whole reason the app is shaped the way it is.

Paying at an MRT gate is not "sending a card number". The gate issues a
cryptographic challenge, and only something holding the card's sector keys can
answer it. Three separate walls stand between an app and that:

1. **The keys are the issuer's.** EasyCard Corporation provisions sector keys
   into certified hardware under a commercial agreement. There is no API, public
   or private, that hands them to an app.
2. **The secure element is locked.** On Android, the embedded secure element —
   the only place those keys could safely live — is gated behind GSMA/Google
   controls. Applets are installed there by the issuer and the OEM, not by an
   APK.
3. **HCE cannot emulate this card type.** Host Card Emulation, the API an
   ordinary app *can* use, only emulates ISO-DEP (ISO 14443-4) smartcards.
   EasyCard is MIFARE Classic, which HCE does not implement at all. Even with
   the keys, there is nothing to run them in.

That is exactly what Samsung Wallet and Google Wallet are: a business deal with
the issuer, plus hardware the issuer has certified. It's a licensing position,
not a technical trick that was missed.

So this app does the part that is genuinely possible, and does it well: it
**reads**. There is no write path anywhere in the codebase, and there should
never be one — writing to a stored-value card is fare fraud, not a feature.

If you want tap-to-pay on your phone in Taiwan, the supported routes are
Samsung Wallet (on supported Samsung handsets) or an EasyCard-issued wearable.

---

## What it actually does

- **Reads balance over NFC.** Hold the card to the phone; the balance appears.
- **Decodes transaction history** — fares and top-ups with timestamps, amounts,
  and the balance after each.
- **Holds multiple cards**, each with a name and a colour that stays stable
  across reinstalls (it's derived from the card's UID).
- **Charts balance across scans**, so you can see it drain between top-ups.
- **Shows the raw sector dump**, so nothing the app claims is unverifiable.
- **Works entirely offline.** The app declares no `INTERNET` permission — not
  "we promise not to phone home", but *cannot*.

## Requirements

- Android 7.0 (API 24) or newer.
- **A phone with MIFARE Classic support.** This is the real constraint. MIFARE
  Classic is an NXP proprietary protocol, so it works on NXP-based NFC chips
  (most Samsung, Sony, and Huawei handsets) and *not* on most Qualcomm-based
  ones, and not at all on iPhone. On an unsupported phone the app says so
  plainly instead of failing mysteriously — no app can work around it.
- A key file (see below).

## Sector keys

The app ships **no** EasyCard keys. It ships only the MIFARE default keys
published in NXP's own datasheets, which won't open a real card's balance
sector.

To read your own card, import a key file in **Settings → Import key file**. The
format is the one MIFARE Classic Tool uses:

```
# one 12-hex-character key per line
FFFFFFFFFFFF
A0A1A2A3A4A5
```

Keys are tried in file order, then the defaults. Use this for cards you own.

## Building

```bash
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest # parser tests
```

## If the history looks wrong

EasyCard's on-card format isn't published; the layout here is the
community-reverse-engineered one, and it has drifted between card generations.

Rather than render whatever falls out of the bytes, the parser sanity-checks
every decoded record — a transaction dated 1974, or a balance of NT$8,000,000,
gets dropped. So a wrong layout produces an honest *"no records decoded"* plus
the raw dump, never a screen of confident nonsense.

If you work out the correct offsets for your card from that dump, they all live
in one place: `EasyCardParser.Layout`. Nothing else needs to change.

## Layout

```
app/src/main/java/tw/easywallet/
├── nfc/
│   ├── EasyCardReader.kt        tap → authenticated sector read (read-only)
│   ├── EasyCardParser.kt        bytes → balance and transactions, with sanity checks
│   ├── KeyStoreFile.kt          user-supplied keys + public MIFARE defaults
│   └── NfcReaderController.kt   NFC reader-mode lifecycle
├── data/                        Room: cards, balance samples, transactions
├── ui/                          Compose wallet, card detail, scan sheet, settings
└── model/                       domain types
```

## Licence and trademarks

Not affiliated with, endorsed by, or connected to EasyCard Corporation
(悠遊卡股份有限公司). "EasyCard" and "悠遊卡" are their trademarks, used here only
to describe what the app reads.
