package tw.easywallet.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tw.easywallet.data.BalanceSampleEntity
import tw.easywallet.data.CardEntity
import tw.easywallet.data.TxnEntity
import tw.easywallet.model.CardSnapshot
import tw.easywallet.util.formatEpochSeconds
import tw.easywallet.util.formatNtd
import tw.easywallet.util.formatRelative
import tw.easywallet.util.formatSignedNtd
import tw.easywallet.util.formatUid

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardDetailScreen(
    card: CardEntity,
    txns: List<TxnEntity>,
    samples: List<BalanceSampleEntity>,
    dump: CardSnapshot?,
    onBack: () -> Unit,
    onRename: (String) -> Unit,
    onDelete: () -> Unit
) {
    var renaming by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(card.nickname) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { renaming = true }) {
                        Icon(Icons.Default.Edit, contentDescription = "Rename")
                    }
                    IconButton(onClick = { confirmDelete = true }) {
                        Icon(Icons.Default.Delete, contentDescription = "Remove card")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item { BalanceHeader(card) }

            if (samples.size >= 2) {
                item { BalanceChart(samples, Color(card.colorArgb)) }
            }

            item {
                SectionTitle(
                    if (txns.isEmpty()) "Transactions" else "Transactions (${txns.size})"
                )
            }

            if (txns.isEmpty()) {
                item { DecodeNotice(dump) }
            } else {
                items(txns, key = { it.rawHex + it.epochSeconds }) { TxnRow(it) }
            }

            if (dump != null) {
                item { SectionTitle("Raw sectors") }
                item { RawDump(dump) }
            }
        }
    }

    if (renaming) {
        RenameDialog(
            initial = card.nickname,
            onDismiss = { renaming = false },
            onConfirm = { renaming = false; onRename(it) }
        )
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Remove this card?") },
            text = {
                Text(
                    "This only removes it from the wallet on this phone. The physical " +
                        "card and its balance are untouched."
                )
            },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) { Text("Remove") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun BalanceHeader(card: CardEntity) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp)) {
            Text("Balance", style = MaterialTheme.typography.labelMedium)
            Text(
                card.lastBalanceNtd?.let(::formatNtd) ?: "—",
                fontSize = 40.sp,
                fontWeight = FontWeight.Bold,
                color = Color(card.colorArgb)
            )
            Text(
                "Read ${formatRelative(card.lastReadEpochMillis)}  ·  UID ${formatUid(card.uid)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Balance over time. Points are tap events, so the line is drawn straight between
 * samples rather than interpolated over time — we genuinely do not know what the
 * balance did between two taps.
 */
@Composable
private fun BalanceChart(samples: List<BalanceSampleEntity>, color: Color) {
    val values = samples.map { it.balanceNtd }
    val min = values.min()
    val max = values.max()
    val span = (max - min).coerceAtLeast(1)

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Balance over your last ${samples.size} scans", style = MaterialTheme.typography.labelMedium)
            Canvas(
                Modifier
                    .fillMaxWidth()
                    .height(120.dp)
                    .padding(top = 12.dp)
            ) {
                val stepX = if (values.size > 1) size.width / (values.size - 1) else 0f
                val points = values.mapIndexed { i, v ->
                    Offset(i * stepX, size.height - (v - min).toFloat() / span * size.height)
                }
                points.zipWithNext { a, b ->
                    drawLine(color = color, start = a, end = b, strokeWidth = 4f)
                }
                points.forEach { drawCircle(color = color, radius = 6f, center = it) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatNtd(min), style = MaterialTheme.typography.bodySmall)
                Text(formatNtd(max), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun TxnRow(txn: TxnEntity) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(txn.kind.lowercase().replaceFirstChar { it.uppercase() })
                Text(
                    formatEpochSeconds(txn.epochSeconds),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    formatSignedNtd(txn.amountNtd),
                    fontWeight = FontWeight.SemiBold,
                    color = if (txn.amountNtd > 0) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface
                )
                Text(
                    formatNtd(txn.balanceAfterNtd),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        HorizontalDivider()
    }
}

/**
 * Shown instead of an empty list. Says which of the two possible causes applies,
 * because "no transactions" and "we couldn't decode them" need different actions.
 */
@Composable
private fun DecodeNotice(dump: CardSnapshot?) {
    val text = when {
        dump == null ->
            "Tap this card again to decode its transaction history."
        dump.sectors.isEmpty() ->
            "No sectors were readable — none of the keys on file matched this card."
        else ->
            "No records decoded from the readable sectors. The record layout differs " +
                "between EasyCard generations; the raw dump below is the ground truth, " +
                "and the offsets live in EasyCardParser.Layout."
    }

    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@Composable
private fun RawDump(dump: CardSnapshot) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            dump.sectors.toSortedMap().forEach { (sector, blocks) ->
                Text(
                    "Sector $sector",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold
                )
                blocks.forEach { block ->
                    Text(
                        block.joinToString(" ") { "%02X".format(it) },
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp
                    )
                }
            }
            if (dump.lockedSectors.isNotEmpty()) {
                Text(
                    "Locked: ${dump.lockedSectors.joinToString(", ")}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 8.dp)
    )
}

@Composable
private fun RenameDialog(initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var value by remember { mutableStateOf(initial) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename card") },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                singleLine = true,
                label = { Text("Name") }
            )
        },
        confirmButton = { TextButton(onClick = { onConfirm(value) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
