package tw.easywallet.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Nfc
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import tw.easywallet.model.ReadFailure
import tw.easywallet.ui.ScanState
import tw.easywallet.util.formatNtd

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScanSheet(
    state: ScanState,
    nfcEnabled: Boolean,
    onDismiss: () -> Unit,
    onOpenKeySettings: () -> Unit
) {
    if (state is ScanState.Idle) return

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp, 8.dp, 24.dp, 48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            when {
                !nfcEnabled -> Message(
                    icon = { Icon(Icons.Default.ErrorOutline, null, Modifier.size(56.dp)) },
                    title = "NFC is off",
                    body = "Turn NFC on in system settings, then try again."
                )

                state is ScanState.Waiting -> {
                    PulsingNfcIcon()
                    Message(
                        title = "Hold your card to the phone",
                        body = "Keep it still against the back of the phone — usually near " +
                            "the top on Android, over the camera area."
                    )
                }

                state is ScanState.Reading -> {
                    CircularProgressIndicator()
                    Message(title = "Reading…", body = "Don't move the card.")
                }

                state is ScanState.Done -> {
                    Icon(
                        Icons.Default.CheckCircle,
                        contentDescription = null,
                        modifier = Modifier.size(56.dp),
                        tint = MaterialTheme.colorScheme.primary
                    )
                    Message(
                        title = state.snapshot.balanceNtd?.let(::formatNtd) ?: "Card saved",
                        body = buildString {
                            append(state.card.nickname)
                            val txns = state.snapshot.transactions.size
                            if (txns > 0) append("  ·  $txns transactions decoded")
                            if (state.snapshot.balanceNtd == null) {
                                append("\n\nThe balance sector didn't decode. Import a key " +
                                    "file for this card and scan again.")
                            }
                        }
                    )
                    if (state.snapshot.lockedSectors.isNotEmpty()) {
                        Text(
                            "${state.snapshot.lockedSectors.size} sectors were locked " +
                                "(no matching key).",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center
                        )
                    }
                }

                state is ScanState.Error -> {
                    Icon(
                        Icons.Default.ErrorOutline,
                        contentDescription = null,
                        modifier = Modifier.size(56.dp),
                        tint = MaterialTheme.colorScheme.error
                    )
                    val (title, body) = describe(state.reason)
                    Message(title = title, body = body)
                    if (state.reason is ReadFailure.NoKeyForBalanceSector) {
                        TextButton(onClick = onOpenKeySettings) { Text("Import a key file") }
                    }
                }
            }

            Spacer(Modifier.height(4.dp))
            TextButton(onClick = onDismiss) { Text("Close") }
        }
    }
}

/** Failure text is written to tell the user what to *do*, not what the API returned. */
private fun describe(reason: ReadFailure): Pair<String, String> = when (reason) {
    ReadFailure.UnsupportedTechnology ->
        "This card can't be read" to
            "The card came up as something other than MIFARE Classic. Many phones " +
                "(most Qualcomm-era models, and all iPhones) simply have no MIFARE " +
                "Classic support in hardware — on those, no app can read an EasyCard."

    ReadFailure.NoKeyForBalanceSector ->
        "No key for the balance sector" to
            "The card was found, but none of the keys on file unlocked the sector " +
                "holding the balance. Import a key file for a card you own."

    ReadFailure.TagLost ->
        "Card moved too soon" to
            "Reading all sectors takes a second or two. Hold the card still and try again."

    is ReadFailure.Io ->
        "Read failed" to reason.message
}

@Composable
private fun Message(
    icon: (@Composable () -> Unit)? = null,
    title: String,
    body: String
) {
    icon?.invoke()
    Text(title, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
    Text(
        body,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center
    )
}

@Composable
private fun PulsingNfcIcon() {
    val transition = rememberInfiniteTransition(label = "nfc")
    val scale by transition.animateFloat(
        initialValue = 0.9f,
        targetValue = 1.15f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "scale"
    )

    Icon(
        Icons.Default.Nfc,
        contentDescription = null,
        modifier = Modifier
            .size(72.dp)
            .scale(scale),
        tint = MaterialTheme.colorScheme.primary
    )
}
