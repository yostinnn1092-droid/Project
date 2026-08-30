package tw.easywallet.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val Teal = Color(0xFF00796B)
private val TealDark = Color(0xFF80CBC4)

private val LightColors = lightColorScheme(
    primary = Teal,
    secondary = Color(0xFF37474F),
    background = Color(0xFFF6F7F9),
    surface = Color(0xFFFFFFFF)
)

private val DarkColors = darkColorScheme(
    primary = TealDark,
    secondary = Color(0xFFB0BEC5),
    background = Color(0xFF101214),
    surface = Color(0xFF1B1E21)
)

@Composable
fun EasyWalletTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colors = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val ctx = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }

    MaterialTheme(colorScheme = colors, content = content)
}

/**
 * Card face colours. Assigned from the UID hash so a given physical card keeps
 * the same colour across reinstalls, which is what makes a stack of cards
 * recognisable at a glance.
 */
object CardPalette {
    private val colors = listOf(
        0xFF00695C.toInt(),
        0xFF1565C0.toInt(),
        0xFF6A1B9A.toInt(),
        0xFFAD1457.toInt(),
        0xFFEF6C00.toInt(),
        0xFF37474F.toInt()
    )

    fun forUid(uid: String): Int = colors[(uid.hashCode().let { if (it == Int.MIN_VALUE) 0 else it }
        .let { kotlin.math.abs(it) }) % colors.size]
}
