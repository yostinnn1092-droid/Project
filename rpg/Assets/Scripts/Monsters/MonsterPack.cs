using System.Collections.Generic;
using UnityEngine;
using Rpg.Combat;

namespace Rpg.Monsters
{
    /// <summary>
    /// A leader and the creatures that follow it.
    ///
    /// This exists to make a fight have a SHAPE. Six identical wolves is an
    /// endurance test, and the only decision in it is which one happens to be
    /// closest. Put a leader among them and the fight acquires a question —
    /// spend yourself reaching the dangerous one, or grind through the escort —
    /// and answering it correctly is rewarded by the pack coming apart.
    ///
    /// The same structure carries the naming system's biggest payoff. Name the
    /// leader and the whole pack comes with it, for ONE place on the roster,
    /// because the pack follows the leader rather than the player. That is the
    /// fiction's own hierarchy — you command the leader, the leader commands its
    /// pack — and it is what makes hunting a leader worth the risk rather than
    /// just a tougher wolf.
    ///
    /// Sits on a parent object with the leader and the members underneath it,
    /// or anywhere with the references filled in by hand.
    /// </summary>
    public class MonsterPack : MonoBehaviour
    {
        [Header("Members")]
        [Tooltip("The one that matters. Leave empty to use the first child " +
                 "MonsterIdentity marked as a leader.")]
        [SerializeField] private MonsterIdentity leader;
        [Tooltip("The rest. Leave empty to collect every other MonsterIdentity " +
                 "underneath this object.")]
        [SerializeField] private List<MonsterIdentity> members = new List<MonsterIdentity>();

        [Header("Morale")]
        [Tooltip("Seconds the pack scatters when its leader is killed. They do " +
                 "not come back hunting afterwards — a broken pack has to be " +
                 "provoked again.")]
        [SerializeField] private float routDuration = 6f;
        [Tooltip("How far a member holds from its leader once the pack is tamed.")]
        [SerializeField] private float memberLeash = 3.5f;
        [Tooltip("While the leader is down but not dead, the pack hesitates rather " +
                 "than breaking — it can still be rallied if the leader gets up.")]
        [SerializeField] private float hesitateDuration = 3f;

        public MonsterIdentity Leader => leader;
        public IReadOnlyList<MonsterIdentity> Members => members;
        /// <summary>True once the leader has fallen for good.</summary>
        public bool Broken { get; private set; }

        private void Awake()
        {
            if (leader == null)
            {
                foreach (var id in GetComponentsInChildren<MonsterIdentity>())
                    if (id.IsLeader) { leader = id; break; }
            }
            if (members.Count == 0)
            {
                foreach (var id in GetComponentsInChildren<MonsterIdentity>())
                    if (id != leader) members.Add(id);
            }
            if (leader == null) return;

            // A wild pack already keeps station on its leader, which is what
            // makes it read as a pack rather than six animals who happen to be
            // standing near each other.
            AnchorMembersToLeader();

            leader.Named += OnLeaderNamed;

            var down = leader.GetComponent<Subduable>();
            if (down != null)
            {
                down.OnCollapsed += OnLeaderCollapsed;
                down.OnRecovered += OnLeaderRecovered;
            }
            var health = leader.GetComponent<Damageable>();
            if (health != null) health.OnDeath.AddListener(OnLeaderDied);
        }

        private void OnDestroy()
        {
            if (leader == null) return;
            leader.Named -= OnLeaderNamed;
            var down = leader.GetComponent<Subduable>();
            if (down != null)
            {
                down.OnCollapsed -= OnLeaderCollapsed;
                down.OnRecovered -= OnLeaderRecovered;
            }
        }

        private void AnchorMembersToLeader()
        {
            for (int i = 0; i < members.Count; i++)
            {
                if (members[i] == null) continue;
                var brain = members[i].GetComponent<IMonsterBrain>();
                brain?.SetHome(leader.transform, memberLeash);
            }
        }

        /// <summary>
        /// The leader is down but alive. The pack wavers rather than breaking —
        /// this is the moment the player is deciding whether to name it, and a
        /// pack that fled here would rob that decision of its danger.
        /// </summary>
        private void OnLeaderCollapsed()
        {
            for (int i = 0; i < members.Count; i++)
            {
                if (members[i] == null) continue;
                var brain = members[i].GetComponent<IMonsterBrain>();
                brain?.Rout(leader.transform.position, hesitateDuration);
            }
        }

        private void OnLeaderRecovered()
        {
            // Nothing to undo. A routing member returns to Idle by itself, and
            // rallying it here would mean the pack punishes a player for the
            // seconds they spent walking over — the hesitation IS the window.
        }

        private void OnLeaderDied()
        {
            if (Broken) return;
            Broken = true;
            for (int i = 0; i < members.Count; i++)
            {
                if (members[i] == null) continue;
                var brain = members[i].GetComponent<IMonsterBrain>();
                brain?.Rout(leader.transform.position, routDuration);
            }
        }

        /// <summary>
        /// The leader has been named, so the pack changes hands with it. Members
        /// are tamed and anchored to the leader, and are deliberately NOT added
        /// to the roster: the player holds the leader, the leader holds the pack.
        /// One name, one place, six wolves.
        /// </summary>
        private void OnLeaderNamed(MonsterIdentity named)
        {
            var familiar = leader.GetComponent<Familiar>();
            FamilyRoster roster = familiar != null ? familiar.Master : null;

            for (int i = 0; i < members.Count; i++)
            {
                var member = members[i];
                if (member == null) continue;

                var health = member.GetComponent<Damageable>();
                if (health != null && health.IsDead) continue;

                var brain = member.GetComponent<IMonsterBrain>();
                brain?.Tame();

                // Subduable arms this on everything tameable and only clears it
                // when one actually goes down. A member that joined without ever
                // collapsing would otherwise be unkillable — and Familiar.BindTo,
                // which normally clears it, is skipped below when there is no
                // roster to bind to.
                if (health != null) health.PreventDeath = false;

                // Given the familiar behaviour so a member picks its own fights
                // and defends, rather than standing about waiting to be told.
                var memberFamiliar = member.GetComponent<Familiar>();
                if (memberFamiliar == null) memberFamiliar = member.gameObject.AddComponent<Familiar>();
                if (roster != null) memberFamiliar.BindTo(roster);
                memberFamiliar.SetAnchor(leader.transform);
                memberFamiliar.Command(FamiliarOrder.Follow);
            }
        }

        /// <summary>
        /// Add a creature to the pack at runtime — for a leader that calls for
        /// help, or a den that keeps producing them.
        /// </summary>
        public void Adopt(MonsterIdentity member)
        {
            if (member == null || member == leader || members.Contains(member)) return;
            members.Add(member);
            if (leader != null)
                member.GetComponent<IMonsterBrain>()?.SetHome(leader.transform, memberLeash);
        }

        private void OnDrawGizmosSelected()
        {
            if (leader == null) return;
            Gizmos.color = new Color(1f, 0.5f, 0.9f, 0.8f);
            foreach (var m in members)
            {
                if (m == null) continue;
                Gizmos.DrawLine(leader.transform.position, m.transform.position);
            }
        }
    }
}
