package tw.easywallet.util

import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val ntd: NumberFormat = NumberFormat.getIntegerInstance(Locale.TAIWAN)

/** EasyCard is denominated in whole NT dollars; never show cents. */
fun formatNtd(amount: Int): String = "NT$" + ntd.format(amount)

fun formatSignedNtd(amount: Int): String =
    (if (amount > 0) "+" else "−") + "NT$" + ntd.format(kotlin.math.abs(amount))

private val dateTime: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm", Locale.TAIWAN)

/** Taipei time — the only timezone an EasyCard is ever tapped in. */
private val taipei: ZoneId = ZoneId.of("Asia/Taipei")

fun formatEpochSeconds(epochSeconds: Long): String =
    dateTime.format(Instant.ofEpochSecond(epochSeconds).atZone(taipei))

fun formatEpochMillis(epochMillis: Long): String =
    dateTime.format(Instant.ofEpochMilli(epochMillis).atZone(taipei))

fun formatRelative(epochMillis: Long, now: Long = System.currentTimeMillis()): String {
    val minutes = (now - epochMillis) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 60 * 24 -> "${minutes / 60}h ago"
        minutes < 60 * 24 * 7 -> "${minutes / (60 * 24)}d ago"
        else -> formatEpochMillis(epochMillis)
    }
}

/** Groups a UID into byte pairs so it can be read off the screen. */
fun formatUid(uid: String): String = uid.chunked(2).joinToString(" ")
