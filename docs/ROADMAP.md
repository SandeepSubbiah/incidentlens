# Roadmap

Current verified capability status: [FEATURE_STATUS.md](FEATURE_STATUS.md). PR #22's provider-neutral continuity router is merged but **not integrated** with live inference. Before production use it needs backend-derived policy, provider adapters, effect records and a measured rollout. The roadmap items below are goals, not shipped functionality.

Ordered by dependency. Nothing here is claimed as done.

1. **Live Muse validation.** Run the eval in solo and War Room modes. Record real runs for
   replay. Compare against an unassisted Muse baseline, plus ablations without RAG and without
   the Skeptic.
2. **Durable control plane.** PostgreSQL with transactions and an outbox for change requests and
   the registry. Access-code revocation. Restart-safe approvals. Optionally an OPA policy bundle.
3. **Real verification of fixes.** Disposable, network-restricted containers. `git apply --check`
   on a clone, then build and run the regression test.
4. **Engineering RAG.** Code symbols and call graph, version- and time-aware retrieval,
   contradiction-seeking retrieval, and promotion of validated postmortems into case memory.
5. **Evaluation at scale.** Fresh held-out incidents written without their solutions, repeated
   runs with confidence intervals, and cost per correct diagnosis.
6. **Multimodal evidence.** Dashboard screenshots and voice incident notes. Muse models accept
   image and audio input.
7. **Product.** Multi-tenant hosting, identity integration, and an open-core model: the engine
   stays public, the learned skill library and hosting stay private.
