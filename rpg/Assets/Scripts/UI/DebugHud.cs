using UnityEngine;
using Rpg.Combat;
using Rpg.Monsters;
using Rpg.Player;

namespace Rpg.UI
{
    /// <summary>
    /// Everything the player needs to read the systems, drawn with IMGUI.
    ///
    /// IMGUI is the wrong tool for a shipping HUD and the right one for this:
    /// it needs no canvas, no prefabs, no fonts and no wiring, so the test scene
    /// stays something a script can build. It is meant to be thrown away the
    /// day there is real UI.
    ///
    /// It exists because the naming system is invisible without it. A wolf that
    /// has collapsed looks much like a wolf that is about to get up, and the
    /// difference is the entire mechanic — so the countdown has to be on screen
    /// or the window cannot be played.
    /// </summary>
    public class DebugHud : MonoBehaviour
    {
        [Tooltip("Found by tag if left empty.")]
        [SerializeField] private GameObject player;
        [SerializeField] private bool showControls = true;
        [Tooltip("Cycled with Tab. A text field would be nicer and is not " +
                 "possible here: legacy Input reads the keyboard straight from " +
                 "the device, so typing a name would also walk the character " +
                 "around and any 'f' in it would confirm the name half-typed.")]
        [SerializeField] private string[] names =
        {
            "Fenrir", "Garm", "Skoll", "Hati", "Vargr", "Amarok", "Sif", "Bran",
        };

        private Damageable _health;
        private FamilyRoster _roster;
        private NamingInteractor _naming;
        private GUIStyle _label, _big, _prompt;
        private int _nameIndex;

        private void Start()
        {
            Bind();
            PushName();
        }

        private void Update()
        {
            if (_naming == null || names == null || names.Length == 0) return;
            if (!Input.GetKeyDown(KeyCode.Tab)) return;
            _nameIndex = (_nameIndex + 1) % names.Length;
            PushName();
        }

        private void PushName()
        {
            if (_naming == null || names == null || names.Length == 0) return;
            _naming.PendingName = names[_nameIndex];
        }

        private void Bind()
        {
            if (player == null) player = GameObject.FindGameObjectWithTag("Player");
            if (player == null) return;
            _health = player.GetComponent<Damageable>();
            _roster = player.GetComponent<FamilyRoster>();
            _naming = player.GetComponent<NamingInteractor>();
        }

        private void EnsureStyles()
        {
            if (_label != null) return;
            _label = new GUIStyle(GUI.skin.label) { fontSize = 14, richText = true };
            _big = new GUIStyle(GUI.skin.label) { fontSize = 20, fontStyle = FontStyle.Bold };
            _prompt = new GUIStyle(GUI.skin.box)
            {
                fontSize = 18,
                alignment = TextAnchor.MiddleCenter,
                wordWrap = true,
            };
        }

        private void OnGUI()
        {
            if (_health == null) { Bind(); if (_health == null) return; }
            EnsureStyles();

            // ── vitals, top left ────────────────────────────────────────────
            GUILayout.BeginArea(new Rect(16, 16, 320, 240));

            Bar("Health", _health.Health, _health.MaxHealth, new Color(0.75f, 0.2f, 0.2f));
            if (_roster != null)
            {
                Bar("Will", _roster.Will, _roster.MaxWill, new Color(0.35f, 0.45f, 0.85f));
                GUILayout.Label($"Family  {_roster.Count} / {_roster.Capacity}", _label);

                for (int i = 0; i < _roster.Family.Count; i++)
                {
                    var f = _roster.Family[i];
                    if (f == null) continue;
                    var fh = f.GetComponent<Damageable>();
                    string hp = fh != null ? $"{Mathf.CeilToInt(fh.Health)}" : "?";
                    GUILayout.Label($"   • {f.Identity.DisplayName} — {f.Order}, {hp} hp", _label);
                }
            }

            GUILayout.EndArea();

            // ── the naming prompt, centre bottom ────────────────────────────
            if (_naming != null && !string.IsNullOrEmpty(_naming.Prompt))
            {
                float w = 560f, h = 64f;
                var r = new Rect((Screen.width - w) * 0.5f, Screen.height - h - 110f, w, h);
                GUI.Box(r, _naming.Prompt, _prompt);

                // Only while something is actually down. The name you are about
                // to give is the decision being made, so it belongs on screen at
                // the moment you make it and nowhere else.
                if (_naming.Candidate != null)
                {
                    var nr = new Rect(r.x, r.yMax + 6f, w, 26f);
                    GUI.Label(nr, $"Name it “{_naming.PendingName}”   ·   Tab for another",
                              new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter });
                }
            }

            if (_health.IsDead)
            {
                var r = new Rect(0, Screen.height * 0.4f, Screen.width, 60);
                GUI.Label(r, "You died.", new GUIStyle(_big)
                {
                    alignment = TextAnchor.MiddleCenter,
                    normal = { textColor = new Color(0.85f, 0.25f, 0.2f) },
                });
            }

            if (!showControls) return;
            GUILayout.BeginArea(new Rect(Screen.width - 236, 16, 220, 200));
            GUILayout.Label(
                "<b>WASD</b>  move\n" +
                "<b>Shift</b>  run\n" +
                "<b>Mouse</b>  look\n" +
                "<b>LMB</b>  attack (chains ×3)\n" +
                "<b>Space</b>  dodge (i-frames)\n" +
                "<b>F</b>  name a downed beast\n" +
                "<b>Tab</b>  pick a different name", _label);
            GUILayout.EndArea();
        }

        private void Bar(string caption, float value, float max, Color fill)
        {
            GUILayout.Label($"{caption}  {Mathf.CeilToInt(value)} / {Mathf.CeilToInt(max)}", _label);
            Rect r = GUILayoutUtility.GetRect(280, 12);
            GUI.color = new Color(0f, 0f, 0f, 0.55f);
            GUI.DrawTexture(r, Texture2D.whiteTexture);
            GUI.color = fill;
            float t = max > 0f ? Mathf.Clamp01(value / max) : 0f;
            GUI.DrawTexture(new Rect(r.x, r.y, r.width * t, r.height), Texture2D.whiteTexture);
            GUI.color = Color.white;
            GUILayout.Space(6);
        }
    }
}
