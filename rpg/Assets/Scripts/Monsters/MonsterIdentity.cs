using UnityEngine;

namespace Rpg.Monsters
{
    /// <summary>
    /// What a creature IS, as opposed to what it is currently doing. Species,
    /// standing, and the price of its name.
    ///
    /// The given name is the interesting field. A wild thing is "a Wolf" —
    /// indefinite, one of many. The moment it is named it becomes "Fenrir", and
    /// nothing else in the world is that. Everything the naming system is for
    /// hangs off that one change, so it lives on its own component rather than
    /// buried in an AI script.
    /// </summary>
    public class MonsterIdentity : MonoBehaviour
    {
        [Header("Species")]
        [SerializeField] private string species = "Wolf";
        [Tooltip("Rough power band. Cost and capacity are priced off this, and " +
                 "later it decides what a name can evolve the creature into.")]
        [SerializeField] private int tier = 1;

        [Header("Standing")]
        [Tooltip("A pack leader. Beating one should matter more than beating any " +
                 "of the pack, and naming one should bring the pack with it.")]
        [SerializeField] private bool isLeader = false;

        [Header("Naming")]
        [Tooltip("Will spent to name this creature. A name is meant to be a real " +
                 "decision, so this should hurt for anything impressive.")]
        [SerializeField] private float namingCost = 20f;
        [Tooltip("What a name is worth to it. Applied to health and damage when " +
                 "it joins — the reason to name a thing rather than just recruit it.")]
        [SerializeField] private float namedPowerMultiplier = 1.35f;

        public string Species => species;
        public int Tier => tier;
        public bool IsLeader => isLeader;
        public float NamingCost => namingCost;
        public float NamedPowerMultiplier => namedPowerMultiplier;

        /// <summary>Empty until named. Set once and never changed.</summary>
        public string GivenName { get; private set; }
        public bool IsNamed => !string.IsNullOrEmpty(GivenName);

        /// <summary>"Fenrir" once named, "Wolf" before — what the UI should show.</summary>
        public string DisplayName => IsNamed ? GivenName : species;

        /// <summary>
        /// Names it, permanently. Refuses a second name: in the fiction a name is
        /// given once and it sticks, and in the code it stops a player renaming
        /// their way out of a bad choice.
        /// </summary>
        public bool Bestow(string name)
        {
            if (IsNamed) return false;
            name = (name ?? string.Empty).Trim();
            if (name.Length == 0) return false;
            GivenName = name;
            return true;
        }
    }
}
