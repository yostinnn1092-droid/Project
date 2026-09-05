using System.IO;
using UnityEditor;
using UnityEngine;

namespace Rpg.EditorTools
{
    /// <summary>
    /// The project-level setup a scene needs before it can be built: layers,
    /// input handling, materials and folders.
    ///
    /// It exists because those four things are exactly what a person gets wrong
    /// when following written instructions, and each one fails silently. A
    /// missing layer makes a sword pass through wolves; the wrong input handler
    /// makes WASD do nothing at all; a Standard material in a URP project turns
    /// the whole scene magenta. None of them produce an error that says what is
    /// wrong, so none of them should be left to hand.
    ///
    /// Everything here is idempotent — run it as often as you like.
    /// </summary>
    internal static class ProjectBootstrap
    {
        public const string PlayerLayer = "Player";
        public const string MonsterLayer = "Monster";

        private const string MaterialFolder = "Assets/Materials";

        /// <summary>Things that went wrong but did not stop the build.</summary>
        public static int Warnings { get; private set; }

        public static void ResetWarnings() => Warnings = 0;

        private static void Warn(string message)
        {
            Warnings++;
            Debug.LogWarning("[RPG setup] " + message);
        }

        // ── serialized fields ───────────────────────────────────────────────
        //
        // Every tunable in this project is a private [SerializeField], which is
        // right for the inspector and unreachable from code. SerializedObject is
        // the sanctioned way in — and it degrades to a warning when a field has
        // been renamed, rather than throwing and leaving half a scene behind.

        public static void SetFloat(Object o, string field, float v) => Set(o, field, p => p.floatValue = v);
        public static void SetInt(Object o, string field, int v) => Set(o, field, p => p.intValue = v);
        public static void SetBool(Object o, string field, bool v) => Set(o, field, p => p.boolValue = v);
        public static void SetString(Object o, string field, string v) => Set(o, field, p => p.stringValue = v);
        public static void SetRef(Object o, string field, Object v) => Set(o, field, p => p.objectReferenceValue = v);
        public static void SetVec3(Object o, string field, Vector3 v) => Set(o, field, p => p.vector3Value = v);

        /// <summary>A LayerMask field, given by layer name.</summary>
        public static void SetMask(Object o, string field, params string[] layers)
            => Set(o, field, p => p.intValue = Mask(layers));

        private static void Set(Object o, string field, System.Action<SerializedProperty> apply)
        {
            if (o == null) { Warn($"nothing to set '{field}' on"); return; }
            var so = new SerializedObject(o);
            var prop = so.FindProperty(field);
            if (prop == null)
            {
                Warn($"{o.GetType().Name} has no serialized field '{field}' — renamed since this builder was written?");
                return;
            }
            apply(prop);
            so.ApplyModifiedPropertiesWithoutUndo();
        }

        public static int Mask(params string[] layers)
        {
            int mask = 0;
            foreach (string name in layers)
            {
                int index = LayerMask.NameToLayer(name);
                if (index < 0) { Warn($"layer '{name}' does not exist"); continue; }
                mask |= 1 << index;
            }
            return mask;
        }

        // ── layers ──────────────────────────────────────────────────────────

        /// <summary>Finds the layer or claims the first free user slot for it.</summary>
        public static int EnsureLayer(string name)
        {
            int existing = LayerMask.NameToLayer(name);
            if (existing >= 0) return existing;

            var settings = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset");
            if (settings == null || settings.Length == 0)
            {
                Warn("could not open ProjectSettings/TagManager.asset to add layers");
                return -1;
            }

            var tagManager = new SerializedObject(settings[0]);
            var layers = tagManager.FindProperty("layers");
            if (layers == null) { Warn("TagManager.asset has no 'layers' property"); return -1; }

            // 0-7 belong to Unity and must not be touched.
            for (int i = 8; i < layers.arraySize; i++)
            {
                var slot = layers.GetArrayElementAtIndex(i);
                if (!string.IsNullOrEmpty(slot.stringValue)) continue;
                slot.stringValue = name;
                tagManager.ApplyModifiedProperties();
                return i;
            }

            Warn($"no free user layer left for '{name}' — free one in Edit ▸ Project Settings ▸ Tags and Layers");
            return -1;
        }

        // ── input ───────────────────────────────────────────────────────────

        /// <summary>
        /// The scripts read <c>Input.GetAxisRaw</c> and <c>Fire1</c>, which the
        /// new Input System package switches off entirely. Returns true if the
        /// setting had to be changed, in which case Unity must be RESTARTED
        /// before anything responds to a key.
        /// </summary>
        public static bool EnsureLegacyInput()
        {
            var settings = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset");
            if (settings == null || settings.Length == 0) return false;

            var so = new SerializedObject(settings[0]);
            var handler = so.FindProperty("activeInputHandler");
            if (handler == null) return false;      // old enough that only the one exists

            // 0 = old, 1 = new only, 2 = both.
            if (handler.intValue != 1) return false;

            handler.intValue = 2;
            so.ApplyModifiedProperties();
            AssetDatabase.SaveAssets();
            return true;
        }

        // ── assets ──────────────────────────────────────────────────────────

        public static Material MakeMaterial(string name, Color colour, float smoothness = 0.15f)
        {
            EnsureFolder(MaterialFolder);
            string path = $"{MaterialFolder}/{name}.mat";

            Shader shader = PipelineShader();
            var material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null)
            {
                material = new Material(shader);
                AssetDatabase.CreateAsset(material, path);
            }
            else if (material.shader != shader)
            {
                material.shader = shader;
            }

            // URP's Lit calls it _BaseColor and the built-in pipeline calls it
            // _Color. Setting both is cheaper than detecting which is in use.
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", colour);
            if (material.HasProperty("_Color")) material.SetColor("_Color", colour);
            if (material.HasProperty("_Smoothness")) material.SetFloat("_Smoothness", smoothness);
            if (material.HasProperty("_Glossiness")) material.SetFloat("_Glossiness", smoothness);

            EditorUtility.SetDirty(material);
            return material;
        }

        /// <summary>
        /// Whichever lit shader this project's render pipeline actually uses. A
        /// Standard material in a URP project renders magenta, which on a first
        /// run reads as "everything is broken" rather than "wrong shader".
        /// </summary>
        private static Shader PipelineShader()
        {
            string[] candidates =
            {
                "Universal Render Pipeline/Lit",
                "HDRP/Lit",
                "Standard",
                "Legacy Shaders/Diffuse",
            };
            foreach (string name in candidates)
            {
                Shader shader = Shader.Find(name);
                if (shader != null) return shader;
            }
            Warn("found no lit shader; the scene will look wrong but will still run");
            return Shader.Find("Sprites/Default");
        }

        public static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            string parent = Path.GetDirectoryName(path)?.Replace('\\', '/');
            string leaf = Path.GetFileName(path);
            if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(leaf)) return;
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
        }
    }
}
