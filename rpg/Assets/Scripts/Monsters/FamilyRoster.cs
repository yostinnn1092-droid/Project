using System;
using System.Collections.Generic;
using UnityEngine;
using Rpg.Combat;

namespace Rpg.Monsters
{
    /// <summary>
    /// Everything the player has named, and what naming costs them.
    ///
    /// Two limits, doing different jobs. WILL is spent per name and comes back
    /// slowly, so naming is paced — you cannot clear a forest and adopt all of
    /// it in one afternoon. CAPACITY is a hard ceiling on how many can be kept
    /// at once, so the late game is a question of who is worth a place rather
    /// than how many can be hoarded. A resource alone would only delay hoarding;
    /// a cap alone would make an early name feel free.
    /// </summary>
    public class FamilyRoster : MonoBehaviour
    {
        [Header("Capacity")]
        [Tooltip("How many named creatures can be kept at once. Meant to grow " +
                 "with the player, so the roster becomes a choice about who stays.")]
        [SerializeField] private int capacity = 3;

        [Header("Will")]
        [Tooltip("The pool a name is paid out of.")]
        [SerializeField] private float maxWill = 100f;
        [Tooltip("Recovered per second. Slow on purpose — this is the clock that " +
                 "makes a name feel spent rather than picked up.")]
        [SerializeField] private float willRegen = 1.5f;

        [Header("Defence")]
        [Tooltip("Named creatures turn on whatever hurts their master. This is " +
                 "the 'they defend us' half of the promise, and it should not " +
                 "need an order.")]
        [SerializeField] private bool defendMaster = true;

        public int Capacity => capacity;
        public int Count => _family.Count;
        public float Will { get; private set; }
        public float MaxWill => maxWill;
        public IReadOnlyList<Familiar> Family => _family;

        public event Action<Familiar> OnNamed;
        public event Action<Familiar> OnLost;

        private readonly List<Familiar> _family = new List<Familiar>();

        private void Awake()
        {
            Will = maxWill;
            if (defendMaster)
            {
                var self = GetComponent<Damageable>();
                if (self != null) self.OnHit.AddListener(OnMasterHurt);
            }
        }

        private void Update()
        {
            if (Will < maxWill) Will = Mathf.Min(maxWill, Will + willRegen * Time.deltaTime);
        }

        /// <summary>
        /// Whether this creature could be named right now, and if not, why. The
        /// reason is returned rather than logged so the prompt can say "no room"
        /// or "not enough will" instead of just refusing silently.
        /// </summary>
        public bool CanName(MonsterIdentity identity, out string reason)
        {
            if (identity == null) { reason = "Nothing there."; return false; }
            if (identity.IsNamed) { reason = $"{identity.DisplayName} already has a name."; return false; }
            if (_family.Count >= capacity) { reason = $"No room. {capacity} is all you can hold."; return false; }
            if (Will < identity.NamingCost)
            {
                reason = $"Not enough will ({Mathf.FloorToInt(Will)}/{Mathf.CeilToInt(identity.NamingCost)}).";
                return false;
            }
            reason = null;
            return true;
        }

        /// <summary>
        /// Names it and takes it in. Returns the new familiar, or null with a
        /// reason if it could not be done.
        /// </summary>
        public Familiar Name(MonsterIdentity identity, string name, out string reason)
        {
            if (!CanName(identity, out reason)) return null;
            if (!identity.Bestow(name)) { reason = "That name will not do."; return null; }

            Will -= identity.NamingCost;

            // A name makes it stronger. This is what separates naming from
            // recruiting, and why spending the will is worth it.
            var health = identity.GetComponent<Damageable>();
            if (health != null) health.ScaleMaxHealth(identity.NamedPowerMultiplier);

            var familiar = identity.GetComponent<Familiar>();
            if (familiar == null) familiar = identity.gameObject.AddComponent<Familiar>();
            familiar.BindTo(this);

            _family.Add(familiar);
            if (health != null) health.OnDeath.AddListener(() => Forget(familiar));

            OnNamed?.Invoke(familiar);
            reason = null;
            return familiar;
        }

        public void Forget(Familiar familiar)
        {
            if (familiar == null) return;
            if (!_family.Remove(familiar)) return;
            OnLost?.Invoke(familiar);
        }

        /// <summary>Point the whole family at something.</summary>
        public void OrderAll(FamiliarOrder order, Transform target = null)
        {
            for (int i = 0; i < _family.Count; i++)
            {
                if (_family[i] == null) continue;
                _family[i].Command(order, target);
            }
        }

        private void OnMasterHurt(Blow blow)
        {
            if (blow.Source == null) return;
            // Never turn the family on each other, and never on the master —
            // friendly fire from a familiar's own claws would otherwise start a
            // brawl inside the party.
            if (blow.Source == gameObject) return;
            if (blow.Source.GetComponent<Familiar>() != null) return;

            for (int i = 0; i < _family.Count; i++)
            {
                if (_family[i] == null) continue;
                _family[i].DefendAgainst(blow.Source.transform);
            }
        }
    }
}
