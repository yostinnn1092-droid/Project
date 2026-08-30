package tw.easywallet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    keyCount: Int,
    nfcSupported: Boolean,
    onBack: () -> Unit,
    onImportKeys: () -> Unit,
    onClearKeys: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            item {
                InfoCard(
                    title = "Why this app can't tap to pay",
                    body = "EasyWallet reads your card. It cannot become your card, and " +
                        "no third-party app can.\n\n" +
                        "Paying at a gate means presenting a card that answers the " +
                        "reader's cryptographic challenge with keys only EasyCard Corp " +
                        "holds. Those keys live in a certified secure element, and the " +
                        "issuer only provisions them into hardware they have personally " +
                        "certified — which is exactly what Samsung Wallet and Google " +
                        "Wallet are: a commercial agreement with the issuer plus a " +
                        "secure element the issuer trusts.\n\n" +
                        "Android's Host Card Emulation, the API a normal app could use, " +
                        "cannot help: HCE only emulates ISO-DEP (ISO 14443-4) cards, and " +
                        "EasyCard is MIFARE Classic, which HCE does not implement at all. " +
                        "Even on a card type HCE could emulate, the app still wouldn't " +
                        "have the keys."
                )
            }

            item {
                InfoCard(
                    title = "Sector keys",
                    body = if (keyCount > 0) {
                        "$keyCount key(s) imported, plus the public MIFARE defaults."
                    } else {
                        "No key file imported. Only the public MIFARE default keys are " +
                            "in use, which will not open an EasyCard's balance sector.\n\n" +
                            "Import a MIFARE Classic Tool style .keys file — one " +
                            "12-character hex key per line — for a card you own."
                    }
                ) {
                    Column {
                        OutlinedButton(onClick = onImportKeys, modifier = Modifier.fillMaxWidth()) {
                            Text("Import key file")
                        }
                        if (keyCount > 0) {
                            TextButton(onClick = onClearKeys, modifier = Modifier.fillMaxWidth()) {
                                Text("Remove imported keys")
                            }
                        }
                    }
                }
            }

            if (!nfcSupported) {
                item {
                    InfoCard(
                        title = "No NFC on this device",
                        body = "Saved cards still display, but nothing can be scanned."
                    )
                }
            }

            item {
                InfoCard(
                    title = "Privacy",
                    body = "Everything stays on the device. There is no account, no " +
                        "analytics, and the app requests no network permission at all — " +
                        "so it could not phone home even if it wanted to.\n\n" +
                        "Raw sector dumps are kept in memory only and are gone when the " +
                        "app is closed."
                )
            }
        }
    }
}

@Composable
private fun InfoCard(title: String, body: String, action: @Composable (() -> Unit)? = null) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            action?.invoke()
        }
    }
}
