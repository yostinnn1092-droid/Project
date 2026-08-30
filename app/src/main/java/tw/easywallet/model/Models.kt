package tw.easywallet.model

/** Which physical card family we detected on the antenna. */
enum class CardKind {
    /** MIFARE Classic 1K/4K — what every EasyCard issued to date uses. */
    MIFARE_CLASSIC,

    /** NFC-A tag that is not MIFARE Classic (many phones can't read these at all). */
    NFC_A_OTHER,

    UNKNOWN
}

/** A single decoded value transaction (a tap, or a top-up). */
data class EasyCardTxn(
    /** Seconds since the Unix epoch, UTC. */
    val epochSeconds: Long,
    /** Signed amount in NT dollars. Negative = spend, positive = top-up. */
    val amountNtd: Int,
    /** Card balance in NT dollars immediately after this transaction. */
    val balanceAfterNtd: Int,
    val kind: TxnKind,
    /** Raw 16-byte record, hex encoded — always kept so a mis-decode is auditable. */
    val rawHex: String
)

enum class TxnKind { FARE, TOP_UP, DEPOSIT, UNKNOWN }

/** The result of one successful tap-and-read. */
data class CardSnapshot(
    /** Tag UID, hex, uppercase, no separators. */
    val uid: String,
    val kind: CardKind,
    val balanceNtd: Int?,
    val transactions: List<EasyCardTxn>,
    /** Sector index -> 16-byte blocks that were readable. Used by the raw dump screen. */
    val sectors: Map<Int, List<ByteArray>>,
    val readAtEpochMillis: Long,
    /** Sectors we could not authenticate against, i.e. missing keys. */
    val lockedSectors: List<Int>
)

/** What went wrong, in terms a user can act on. */
sealed interface ReadFailure {
    /** Tag is not MIFARE Classic — most likely the phone's NFC chip can't do it. */
    data object UnsupportedTechnology : ReadFailure

    /** We connected, but no key in the key file opened the balance sector. */
    data object NoKeyForBalanceSector : ReadFailure

    /** Card moved away mid-read. */
    data object TagLost : ReadFailure

    data class Io(val message: String) : ReadFailure
}
