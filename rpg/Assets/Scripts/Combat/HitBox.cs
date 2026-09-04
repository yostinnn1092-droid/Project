using System.Collections.Generic;
using UnityEngine;

namespace Rpg.Combat
{
    /// <summary>
    /// The live part of a swing. Sits on the weapon (or on a fist, or a wolf's
    /// jaw) and is switched on only during the active frames of an attack.
    ///
    /// It sweeps with <see cref="Physics.OverlapBox"/> every frame it is open
    /// rather than relying on trigger callbacks. A trigger can be missed
    /// entirely when a fast blade crosses a thin body between two physics
    /// steps, and "my sword went through it and nothing happened" is the single
    /// worst bug a melee game can have.
    ///
    /// Each opening remembers what it has already struck, so one swing hits a
    /// given body once no matter how many frames it stays inside it — while a
    /// wide swing can still catch several bodies.
    /// </summary>
    public class HitBox : MonoBehaviour
    {
        [Header("Shape")]
        [Tooltip("Half-extents of the box, in local space.")]
        [SerializeField] private Vector3 halfExtents = new Vector3(0.25f, 0.25f, 0.9f);
        [SerializeField] private Vector3 localOffset = new Vector3(0f, 0f, 0.6f);

        [Header("Targets")]
        [SerializeField] private LayerMask hitLayers = ~0;

        [Header("Debug")]
        [Tooltip("Draw the box in the Scene view. Leave on while tuning reach — " +
                 "a hitbox you cannot see is a hitbox you cannot judge.")]
        [SerializeField] private bool drawGizmo = true;

        /// <summary>Whose swing this is; never hits its own owner.</summary>
        public GameObject Owner { get; set; }

        private bool _open;
        private Blow _template;
        private readonly HashSet<Damageable> _alreadyHit = new HashSet<Damageable>();
        private readonly Collider[] _overlaps = new Collider[16];

        /// <summary>Begin the active frames of a swing.</summary>
        public void Open(Blow template)
        {
            _template = template;
            _alreadyHit.Clear();
            _open = true;
        }

        public void Close() => _open = false;

        private void FixedUpdate()
        {
            if (!_open) return;

            Vector3 centre = transform.TransformPoint(localOffset);
            int count = Physics.OverlapBoxNonAlloc(
                centre, halfExtents, _overlaps, transform.rotation,
                hitLayers, QueryTriggerInteraction.Ignore);

            for (int i = 0; i < count; i++)
            {
                var target = _overlaps[i].GetComponentInParent<Damageable>();
                if (target == null) continue;
                if (Owner != null && target.gameObject == Owner) continue;
                if (!_alreadyHit.Add(target)) continue;      // already struck by THIS swing

                Blow blow = _template;
                blow.Point = _overlaps[i].ClosestPoint(centre);
                // From the attacker toward the target, flattened: knockback that
                // lifts a body off the ground looks like a bug, not a hit.
                Vector3 away = target.transform.position - transform.position;
                away.y = 0f;
                blow.Direction = away.sqrMagnitude > 0.0001f
                    ? away.normalized
                    : transform.forward;

                target.TakeHit(blow);
            }
        }

        private void OnDrawGizmosSelected()
        {
            if (!drawGizmo) return;
            Gizmos.color = _open ? new Color(1f, 0.3f, 0.2f, 0.55f)
                                 : new Color(1f, 1f, 1f, 0.15f);
            Matrix4x4 prev = Gizmos.matrix;
            Gizmos.matrix = Matrix4x4.TRS(
                transform.TransformPoint(localOffset), transform.rotation, Vector3.one);
            Gizmos.DrawCube(Vector3.zero, halfExtents * 2f);
            Gizmos.matrix = prev;
        }
    }
}
