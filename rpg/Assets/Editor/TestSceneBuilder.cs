using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Rpg.AI;
using Rpg.Combat;
using Rpg.Core;
using Rpg.Monsters;
using Rpg.Player;
using Rpg.UI;

namespace Rpg.EditorTools
{
    /// <summary>
    /// Builds a playable scene from nothing, in one menu click.
    ///
    /// This project has no prefabs and no scene checked in, on purpose: a Unity
    /// scene is opaque binary-ish YAML that cannot be reviewed, diffed, or
    /// written correctly by anything but Unity itself. The alternative to a
    /// builder is a page of instructions ending in "drag the WolfAI component
    /// into the Brain slot", which is roughly forty chances to make a mistake
    /// that shows up as a silent nothing an hour later.
    ///
    /// So the scene is CODE. It is reviewable, it is repeatable, and when a
    /// field is renamed this file fails loudly instead of leaving an empty slot.
    ///
    /// Tools ▸ RPG ▸ Build Test Scene.
    /// </summary>
    internal static class TestSceneBuilder
    {
        private const string ScenePath = "Assets/Scenes/Arena.unity";

        // Far enough that the pack does not charge the moment the scene loads —
        // WolfAI notices at 14m. The first half-minute is meant to be yours, to
        // find out what the sword feels like on something that cannot bite back.
        private static readonly Vector3 DummyAt = new Vector3(0f, 0f, 7f);
        private static readonly Vector3 PackAt = new Vector3(3f, 0f, 24f);

        [MenuItem("Tools/RPG/Build Test Scene")]
        public static void Build()
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;

            ProjectBootstrap.ResetWarnings();
            bool restartNeeded = ProjectBootstrap.EnsureLegacyInput();
            ProjectBootstrap.EnsureLayer(ProjectBootstrap.PlayerLayer);
            ProjectBootstrap.EnsureLayer(ProjectBootstrap.MonsterLayer);

            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

            BuildGround();
            BuildSystems();
            GameObject player = BuildPlayer();
            BuildCamera(scene, player);
            BuildDummy();
            BuildPack(player);
            LightIt(scene);

            ProjectBootstrap.EnsureFolder("Assets/Scenes");
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();

            Report(restartNeeded);
        }

        private static void Report(bool restartNeeded)
        {
            int warnings = ProjectBootstrap.Warnings;
            string body = warnings == 0
                ? $"Built and saved {ScenePath}.\n\nPress Play."
                : $"Built and saved {ScenePath}, with {warnings} warning(s).\n\n" +
                  "Check the Console — something is wired up wrong, most likely a " +
                  "field that has been renamed since this builder was written.";

            if (restartNeeded)
            {
                body += "\n\nInput handling was set to 'Both' so WASD works. " +
                        "UNITY MUST BE RESTARTED before that takes effect — until " +
                        "you do, nothing will respond to a key.";
            }

            Debug.Log("[RPG] " + body.Replace("\n\n", " "));
            EditorUtility.DisplayDialog("RPG test scene", body, "OK");
        }

        // ── the world ───────────────────────────────────────────────────────

        private static void BuildGround()
        {
            var ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            ground.name = "Ground";
            ground.transform.localScale = new Vector3(12f, 1f, 12f);   // 120m
            Paint(ground, "Ground", new Color(0.24f, 0.27f, 0.20f));

            // Left on Default so the camera's spring arm collides with the
            // ground and nothing else. Putting it on a custom layer is the
            // classic way to end up with a camera that clips through the floor.
        }

        private static void LightIt(Scene scene)
        {
            // Walked from the scene's own roots rather than found globally:
            // FindObjectOfType is deprecated in current Unity and, worse, can
            // answer from a scene that is on its way out.
            Light light = null;
            foreach (var root in scene.GetRootGameObjects())
            {
                light = root.GetComponentInChildren<Light>();
                if (light != null) break;
            }
            if (light == null) return;
            light.transform.rotation = Quaternion.Euler(48f, -35f, 0f);
            light.color = new Color(1f, 0.96f, 0.88f);
            light.intensity = 1.15f;
            light.shadows = LightShadows.Soft;
        }

        private static void BuildSystems()
        {
            var systems = new GameObject("— Systems —");
            systems.AddComponent<Hitstop>();
            systems.AddComponent<DebugHud>();
        }

        // ── the player ──────────────────────────────────────────────────────

        private static GameObject BuildPlayer()
        {
            var player = new GameObject("Player");
            player.tag = "Player";
            player.transform.position = new Vector3(0f, 0.1f, 0f);

            var controller = player.AddComponent<CharacterController>();
            controller.radius = 0.35f;
            controller.height = 1.75f;
            controller.center = new Vector3(0f, 0.9f, 0f);
            controller.slopeLimit = 50f;
            controller.stepOffset = 0.35f;

            var health = player.AddComponent<Damageable>();
            ProjectBootstrap.SetFloat(health, "maxHealth", 160f);
            ProjectBootstrap.SetFloat(health, "maxPoise", 60f);

            player.AddComponent<KnockbackReceiver>();

            var body = Visual(PrimitiveType.Capsule, player.transform,
                              new Vector3(0f, 0.9f, 0f), Vector3.one * 0.9f);
            body.name = "Body";
            Paint(body, "Player", new Color(0.62f, 0.64f, 0.70f), 0.35f);

            // A blade you can see, so the reach the hitbox claims and the reach
            // the eye expects are the same thing. They very often are not.
            var blade = Visual(PrimitiveType.Cube, player.transform,
                               new Vector3(0.34f, 1.0f, 0.55f),
                               new Vector3(0.07f, 0.07f, 1.05f));
            blade.name = "Blade";
            Paint(blade, "Steel", new Color(0.80f, 0.82f, 0.86f), 0.75f);

            // The hitbox sits on the body rather than on the blade mesh: it must
            // track where the character is FACING, not where an unanimated prop
            // happens to hang.
            var swing = new GameObject("Weapon HitBox");
            swing.transform.SetParent(player.transform, false);
            swing.transform.localPosition = new Vector3(0f, 1.0f, 0f);
            var hitBox = swing.AddComponent<HitBox>();
            ProjectBootstrap.SetVec3(hitBox, "halfExtents", new Vector3(0.55f, 0.45f, 0.80f));
            ProjectBootstrap.SetVec3(hitBox, "localOffset", new Vector3(0f, 0f, 0.85f));
            ProjectBootstrap.SetMask(hitBox, "hitLayers", ProjectBootstrap.MonsterLayer);

            player.AddComponent<PlayerLocomotion>();
            var combat = player.AddComponent<PlayerCombat>();
            ProjectBootstrap.SetRef(combat, "weaponHitBox", hitBox);
            ProjectBootstrap.SetRef(combat, "self", health);

            var roster = player.AddComponent<FamilyRoster>();
            var naming = player.AddComponent<NamingInteractor>();
            ProjectBootstrap.SetRef(naming, "roster", roster);
            ProjectBootstrap.SetMask(naming, "monsterLayers", ProjectBootstrap.MonsterLayer);

            // Last, so the blade, the body and the hitbox go with it. Setting
            // the layer on the root before its children exist is the standard
            // way to end up with half a rig on Default.
            SetLayerTree(player, ProjectBootstrap.PlayerLayer);
            return player;
        }

        private static void BuildCamera(Scene scene, GameObject player)
        {
            Camera cam = null;
            foreach (var root in scene.GetRootGameObjects())
            {
                cam = root.GetComponentInChildren<Camera>();
                if (cam != null) break;
            }
            if (cam == null)
            {
                var go = new GameObject("Main Camera") { tag = "MainCamera" };
                cam = go.AddComponent<Camera>();
                go.AddComponent<AudioListener>();
            }

            cam.transform.position = new Vector3(0f, 2.4f, -4.5f);
            var orbit = cam.gameObject.AddComponent<OrbitCamera>();
            ProjectBootstrap.SetRef(orbit, "target", player.transform);
            // Default only: the ground and future scenery. If this included the
            // monster layer the camera would ram itself into the player's face
            // every time a wolf ran behind them.
            ProjectBootstrap.SetMask(orbit, "collideWith", "Default");

            var locomotion = player.GetComponent<PlayerLocomotion>();
            if (locomotion != null)
                ProjectBootstrap.SetRef(locomotion, "cameraTransform", cam.transform);
        }

        // ── things to hit ───────────────────────────────────────────────────

        private static void BuildDummy()
        {
            var dummy = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            dummy.name = "Training Dummy";
            dummy.transform.position = DummyAt + new Vector3(0f, 1f, 0f);
            dummy.transform.localScale = new Vector3(0.9f, 1f, 0.9f);
            SetLayerTree(dummy, ProjectBootstrap.MonsterLayer);
            Paint(dummy, "Dummy", new Color(0.55f, 0.42f, 0.28f));

            var health = dummy.AddComponent<Damageable>();
            ProjectBootstrap.SetFloat(health, "maxHealth", 99999f);
            ProjectBootstrap.SetFloat(health, "maxPoise", 99999f);

            // No KnockbackReceiver on purpose. It has no CharacterController, so
            // knockback would push its transform and never stop — and an anvil
            // that does not move is the better instrument anyway: it isolates
            // what the SWING feels like from what the reaction feels like.
        }

        private static GameObject BuildPack(GameObject player)
        {
            var pack = new GameObject("Wolf Pack");
            pack.transform.position = PackAt;

            GameObject leader = BuildWolf(pack.transform, "Alpha", PackAt, true);
            var offsets = new[]
            {
                new Vector3(-3.2f, 0f, 1.1f),
                new Vector3(3.0f, 0f, 0.4f),
                new Vector3(-1.4f, 0f, 3.0f),
                new Vector3(2.1f, 0f, 3.4f),
            };
            for (int i = 0; i < offsets.Length; i++)
                BuildWolf(pack.transform, $"Wolf {i + 1}", PackAt + offsets[i], false);

            var component = pack.AddComponent<MonsterPack>();
            // Left for MonsterPack.Awake to collect from its children — the same
            // path a hand-built pack takes, so this scene exercises it rather
            // than quietly bypassing it.
            ProjectBootstrap.SetFloat(component, "routDuration", 7f);
            ProjectBootstrap.SetFloat(component, "hesitateDuration", 3.5f);

            // Face the player, so the first thing you see is a pack looking back.
            foreach (Transform wolf in pack.transform)
                wolf.rotation = Quaternion.LookRotation(
                    Flat(player.transform.position - wolf.position), Vector3.up);

            return leader;
        }

        private static GameObject BuildWolf(Transform parent, string name, Vector3 at, bool leader)
        {
            var wolf = new GameObject(name);
            wolf.transform.SetParent(parent, true);
            wolf.transform.position = at + new Vector3(0f, 0.1f, 0f);
            if (leader) wolf.transform.localScale = Vector3.one * 1.3f;

            var controller = wolf.AddComponent<CharacterController>();
            controller.radius = 0.42f;
            controller.height = 0.95f;
            controller.center = new Vector3(0f, 0.5f, 0f);
            controller.stepOffset = 0.4f;

            var health = wolf.AddComponent<Damageable>();
            ProjectBootstrap.SetFloat(health, "maxHealth", leader ? 260f : 110f);
            ProjectBootstrap.SetFloat(health, "maxPoise", leader ? 70f : 26f);

            var knock = wolf.AddComponent<KnockbackReceiver>();
            ProjectBootstrap.SetFloat(knock, "resistance", leader ? 0.45f : 1f);

            // ── body ──
            Color coat = leader ? new Color(0.34f, 0.13f, 0.14f) : new Color(0.30f, 0.30f, 0.33f);
            string coatName = leader ? "Alpha Coat" : "Wolf Coat";

            var body = Visual(PrimitiveType.Capsule, wolf.transform,
                              new Vector3(0f, 0.5f, 0f), new Vector3(0.52f, 0.62f, 0.52f));
            body.name = "Body";
            body.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);   // lie along Z
            Paint(body, coatName, coat);

            var head = Visual(PrimitiveType.Cube, wolf.transform,
                              new Vector3(0f, 0.62f, 0.62f), new Vector3(0.34f, 0.30f, 0.42f));
            head.name = "Head";
            Paint(head, coatName, coat);

            // A pale snout, purely so the direction it is facing is readable at
            // twenty metres. The telegraph is a promise about where the lunge
            // will GO, and a promise you cannot see is not one.
            var snout = Visual(PrimitiveType.Cube, wolf.transform,
                               new Vector3(0f, 0.57f, 0.86f), new Vector3(0.19f, 0.16f, 0.22f));
            snout.name = "Snout";
            Paint(snout, "Snout", new Color(0.86f, 0.84f, 0.78f));

            if (leader)
            {
                // The pack mechanic is unplayable if you cannot tell at a glance
                // which one is the leader. Bigger and darker is not enough at
                // distance, in a fight, with four of them moving.
                var crest = Visual(PrimitiveType.Cube, wolf.transform,
                                   new Vector3(0f, 1.15f, 0.1f), new Vector3(0.12f, 0.42f, 0.12f));
                crest.name = "Crest";
                Paint(crest, "Crest", new Color(0.95f, 0.72f, 0.18f), 0.6f);
            }

            // ── jaws ──
            var jawsObject = new GameObject("Jaws");
            jawsObject.transform.SetParent(wolf.transform, false);
            jawsObject.transform.localPosition = new Vector3(0f, 0.55f, 0.5f);
            var jaws = jawsObject.AddComponent<HitBox>();
            ProjectBootstrap.SetVec3(jaws, "halfExtents", new Vector3(0.32f, 0.30f, 0.40f));
            ProjectBootstrap.SetVec3(jaws, "localOffset", new Vector3(0f, 0f, 0.30f));
            // Player AND monsters: a wolf that joins the player has to be able to
            // fight the ones that did not. Familiar.BindTo narrows this to the
            // familiar's own hostile mask the moment it changes sides, so a pet
            // cannot bite its owner.
            ProjectBootstrap.SetMask(jaws, "hitLayers",
                                     ProjectBootstrap.PlayerLayer, ProjectBootstrap.MonsterLayer);

            var brain = wolf.AddComponent<WolfAI>();
            ProjectBootstrap.SetRef(brain, "jaws", jaws);
            if (leader)
            {
                ProjectBootstrap.SetFloat(brain, "damage", 20f);
                ProjectBootstrap.SetFloat(brain, "telegraph", 0.52f);   // slower tell, harder hit
                ProjectBootstrap.SetFloat(brain, "attackCooldown", 1.7f);
                ProjectBootstrap.SetFloat(brain, "noticeRange", 17f);
            }

            var identity = wolf.AddComponent<MonsterIdentity>();
            ProjectBootstrap.SetString(identity, "species", leader ? "Dire Wolf" : "Wolf");
            ProjectBootstrap.SetInt(identity, "tier", leader ? 2 : 1);
            ProjectBootstrap.SetBool(identity, "isLeader", leader);
            ProjectBootstrap.SetFloat(identity, "namingCost", leader ? 55f : 20f);
            ProjectBootstrap.SetFloat(identity, "namedPowerMultiplier", leader ? 1.5f : 1.3f);

            var subduable = wolf.AddComponent<Subduable>();
            ProjectBootstrap.SetRef(subduable, "brain", brain);
            ProjectBootstrap.SetFloat(subduable, "downFor", leader ? 7f : 6f);

            var familiar = wolf.AddComponent<Familiar>();
            // What it will fight for you once it is yours. Not the player's layer
            // and not Default — the ground is not an enemy.
            ProjectBootstrap.SetMask(familiar, "hostileLayers", ProjectBootstrap.MonsterLayer);

            SetLayerTree(wolf, ProjectBootstrap.MonsterLayer);
            return wolf;
        }

        // ── helpers ─────────────────────────────────────────────────────────

        /// <summary>A primitive with its collider stripped: something to look at, nothing more.</summary>
        private static GameObject Visual(PrimitiveType type, Transform parent, Vector3 at, Vector3 scale)
        {
            var go = GameObject.CreatePrimitive(type);
            var collider = go.GetComponent<Collider>();
            if (collider != null) Object.DestroyImmediate(collider);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = at;
            go.transform.localScale = scale;
            return go;
        }

        private static void Paint(GameObject go, string materialName, Color colour, float smoothness = 0.15f)
        {
            var renderer = go.GetComponent<Renderer>();
            if (renderer == null) return;
            renderer.sharedMaterial = ProjectBootstrap.MakeMaterial(materialName, colour, smoothness);
        }

        private static void SetLayerTree(GameObject root, string layerName)
        {
            int layer = LayerMask.NameToLayer(layerName);
            if (layer < 0) return;
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
                t.gameObject.layer = layer;
        }

        private static Vector3 Flat(Vector3 v)
        {
            v.y = 0f;
            return v.sqrMagnitude > 0.0001f ? v.normalized : Vector3.forward;
        }
    }
}
