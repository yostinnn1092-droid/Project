using System.Collections;
using UnityEngine;

namespace Rpg.Core
{
    /// <summary>
    /// Freezes the game for a few dozen milliseconds when a blow lands.
    ///
    /// This is the single cheapest thing that makes melee feel heavy. Without
    /// it a sword passes through a body at constant speed and reads as a
    /// cursor touching a sprite; with it the swing stops dead on contact and
    /// the weight is implied by the pause rather than by any animation.
    ///
    /// Kept as one global rather than per-actor on purpose: two overlapping
    /// freezes must not multiply into a long stall, so a new request only
    /// EXTENDS an active one to the longer of the two.
    /// </summary>
    public class Hitstop : MonoBehaviour
    {
        public static Hitstop Instance { get; private set; }

        [Tooltip("Time scale during a freeze. Not zero: a hair of motion reads " +
                 "as impact rather than as the game hitching.")]
        [SerializeField] private float frozenTimeScale = 0.05f;

        private float _remaining;
        private Coroutine _running;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
        }

        private void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Freeze for <paramref name="seconds"/>, or extend a freeze already running.</summary>
        public static void Freeze(float seconds)
        {
            if (Instance == null) return;          // fine to call before the rig exists
            Instance.FreezeInternal(seconds);
        }

        private void FreezeInternal(float seconds)
        {
            _remaining = Mathf.Max(_remaining, seconds);
            if (_running == null) _running = StartCoroutine(Run());
        }

        private IEnumerator Run()
        {
            Time.timeScale = frozenTimeScale;
            // Unscaled, or the freeze would slow the very timer meant to end it.
            while (_remaining > 0f)
            {
                _remaining -= Time.unscaledDeltaTime;
                yield return null;
            }
            Time.timeScale = 1f;
            _running = null;
        }
    }
}
