using UnityEngine;
using Rpg.Combat;

namespace Rpg.Monsters
{
    public enum FamiliarOrder
    {
        /// <summary>Stay near the master and fight anything that starts trouble.</summary>
        Follow,
        /// <summary>Hold this ground and fight what comes to it.</summary>
        Hold,
        /// <summary>Go and kill that.</summary>
        Attack,
        /// <summary>Stay out of it.</summary>
        Wait,
    }

    /// <summary>
    /// What a named creature does. Deliberately thin: it decides WHERE to be and
    /// WHO to fight, and hands both to the creature's own brain through
    /// <see cref="IMonsterBrain"/>. It never moves the body itself.
    ///
    /// That split is the point. A familiar layer that drove movement directly
    /// would make every named creature move identically, and a named Minotaur
    /// would just be a large wolf. Here a wolf keeps circling and lunging, and
    /// whatever is added later keeps whatever makes it itself.
    /// </summary>
    [RequireComponent(typeof(MonsterIdentity))]
    public class Familiar : MonoBehaviour
    {
        [Header("Spacing")]
        [Tooltip("How far from the master it is happy to sit while following.")]
        [SerializeField] private float leash = 4.5f;
        [Tooltip("How far it will look for something to fight on its own.")]
        [SerializeField] private float watchRadius = 12f;
        [Tooltip("How far it will chase before giving up and coming back. Without " +
                 "this a familiar wanders off after one runner and is never seen again.")]
        [SerializeField] private float chaseLimit = 20f;

        [Header("Targets")]
        [Tooltip("Layers it treats as fair game. Must not include the master's " +
                 "layer or the family's own.")]
        [SerializeField] private LayerMask hostileLayers = ~0;
        [Tooltip("How often it looks around, in seconds. Cheap, because this runs " +
                 "on every familiar at once.")]
        [SerializeField] private float rethinkEvery = 0.35f;

        public FamiliarOrder Order { get; private set; } = FamiliarOrder.Follow;
        public MonsterIdentity Identity { get; private set; }
        public FamilyRoster Master { get; private set; }
        public Transform CurrentTarget { get; private set; }

        /// <summary>
        /// Actually belongs to someone. The component can sit on a wild creature
        /// long before that — a scene wants to configure which layers it will
        /// fight for you without deciding that it already has — so everything
        /// that asks "is this one of ours?" must ask THIS, not whether the
        /// component exists.
        /// </summary>
        public bool IsBound => Master != null;

        private IMonsterBrain _brain;
        private Damageable _health;
        private Transform _holdAt;
        private Transform _anchorOverride;
        private float _nextThink;
        private readonly Collider[] _nearby = new Collider[24];
        private Transform _holdMarker;

        private void Awake()
        {
            Identity = GetComponent<MonsterIdentity>();
            _brain = GetComponent<IMonsterBrain>();
            _health = GetComponent<Damageable>();

            // Anything that hurts it gets its attention, order permitting. A
            // creature that stands still being chewed on because it was told to
            // Follow reads as broken rather than obedient.
            if (_health != null) _health.OnHit.AddListener(OnHurt);
        }

        public void BindTo(FamilyRoster master)
        {
            Master = master;
            Order = FamiliarOrder.Follow;
            _brain?.SetHome(AnchorPoint(), leash);

            // Anything that has joined you dies like anything else. Subduable
            // arms this on every creature that can be taken alive and only
            // clears it when one actually collapses — so a pack member that
            // joined with its leader, having never gone down itself, would have
            // been quietly unkillable for the rest of the game.
            if (_health != null) _health.PreventDeath = false;

            // Its weapons change sides with it. hostileLayers is already this
            // familiar's own statement of what is fair game, so pointing its
            // jaws at the same mask keeps one answer in one place.
            foreach (var box in GetComponentsInChildren<HitBox>(true))
                box.HitLayers = hostileLayers;
        }

        public void Command(FamiliarOrder order, Transform target = null)
        {
            Order = order;
            switch (order)
            {
                case FamiliarOrder.Attack:
                    CurrentTarget = target;
                    _brain?.SetTarget(target);
                    break;

                case FamiliarOrder.Hold:
                    // Remembers the spot as a real transform, because the brain
                    // wants somewhere to stand rather than a position it has to
                    // be told again every frame.
                    if (_holdMarker == null)
                    {
                        var go = new GameObject($"{Identity.DisplayName} hold point");
                        _holdMarker = go.transform;
                    }
                    _holdMarker.position = transform.position;
                    _holdAt = _holdMarker;
                    CurrentTarget = null;
                    _brain?.SetTarget(null);
                    _brain?.SetHome(_holdAt, leash);
                    break;

                case FamiliarOrder.Wait:
                    CurrentTarget = null;
                    _brain?.SetTarget(null);
                    break;

                case FamiliarOrder.Follow:
                    _holdAt = null;
                    CurrentTarget = null;
                    _brain?.SetTarget(null);
                    _brain?.SetHome(AnchorPoint(), leash);
                    break;
            }
        }

        /// <summary>Something hurt the master. Answer it unless told to stay out.</summary>
        public void DefendAgainst(Transform attacker)
        {
            if (Order == FamiliarOrder.Wait) return;
            if (attacker == null) return;
            CurrentTarget = attacker;
            _brain?.SetTarget(attacker);
        }

        private void OnHurt(Blow blow)
        {
            if (!IsBound) return;
            if (Order == FamiliarOrder.Wait) return;
            if (blow.Source == null) return;
            if (blow.Source.GetComponent<Familiar>() != null) return;   // never the family
            if (Master != null && blow.Source == Master.gameObject) return;  // nor the master
            if (CurrentTarget == null) { CurrentTarget = blow.Source.transform; _brain?.SetTarget(CurrentTarget); }
        }

        private void Update()
        {
            // Inert until it has a master. Otherwise a wild wolf carrying this
            // component for its settings would start hunting down the layers it
            // is one day meant to fight FOR you — which, since those layers
            // include the other monsters, means the pack attacking itself.
            if (!IsBound) return;
            if (_health != null && _health.IsDead) return;
            if (Time.time < _nextThink) return;
            _nextThink = Time.time + rethinkEvery;

            // A target that died, vanished, or was dragged too far away stops
            // being the plan.
            if (CurrentTarget != null)
            {
                var th = CurrentTarget.GetComponentInParent<Damageable>();
                bool gone = !CurrentTarget.gameObject.activeInHierarchy || (th != null && th.IsDead);
                bool tooFar = AnchorPoint() != null &&
                              Vector3.Distance(CurrentTarget.position, AnchorPoint().position) > chaseLimit;
                if (gone || tooFar)
                {
                    CurrentTarget = null;
                    _brain?.SetTarget(null);
                }
            }

            if (Order == FamiliarOrder.Wait) return;
            if (Order == FamiliarOrder.Attack && CurrentTarget != null) return;  // has its orders

            if (CurrentTarget == null) AcquireNearby();
        }

        /// <summary>
        /// Keep station on something other than the master. A pack member is
        /// anchored to its LEADER, so the chain runs player to leader to pack —
        /// which is the hierarchy the fiction promises and the reason a leader
        /// costs one slot rather than the pack costing six.
        /// </summary>
        public void SetAnchor(Transform anchor)
        {
            _anchorOverride = anchor;
            if (Order == FamiliarOrder.Follow) _brain?.SetHome(AnchorPoint(), leash);
        }

        /// <summary>The point it is tethered to — its anchor, or the ground it holds.</summary>
        private Transform AnchorPoint()
        {
            if (Order == FamiliarOrder.Hold && _holdAt != null) return _holdAt;
            if (_anchorOverride != null) return _anchorOverride;
            return Master != null ? Master.transform : null;
        }

        private void AcquireNearby()
        {
            Transform anchor = AnchorPoint();
            Vector3 from = anchor != null ? anchor.position : transform.position;

            int count = Physics.OverlapSphereNonAlloc(
                transform.position, watchRadius, _nearby, hostileLayers,
                QueryTriggerInteraction.Ignore);

            Transform best = null;
            float bestDist = float.MaxValue;
            for (int i = 0; i < count; i++)
            {
                var candidate = _nearby[i].GetComponentInParent<Damageable>();
                if (candidate == null || candidate.IsDead) continue;
                if (candidate.gameObject == gameObject) continue;
                if (candidate.GetComponent<Familiar>() != null) continue;        // family
                if (Master != null && candidate.gameObject == Master.gameObject) continue;

                // A creature already broken is not a threat, and finishing it is
                // the player's call — a familiar should not rob them of a naming.
                var down = candidate.GetComponent<Subduable>();
                if (down != null && down.IsDown) continue;

                float d = Vector3.Distance(candidate.transform.position, from);
                if (d > chaseLimit) continue;
                if (d < bestDist) { bestDist = d; best = candidate.transform; }
            }

            if (best != CurrentTarget)
            {
                CurrentTarget = best;
                _brain?.SetTarget(best);
            }
        }

        private void OnDestroy()
        {
            if (_holdMarker != null) Destroy(_holdMarker.gameObject);
        }
    }
}
