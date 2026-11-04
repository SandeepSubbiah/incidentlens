# Decision log

Decisions that are expensive to reverse, with the alternatives we turned down.

**D1. Node 24 running TypeScript directly, no runtime dependencies.**
Fewest moving parts for a one-day build and a clean-clone demo. Rejected: Spring Boot backend
(slower to iterate here; the Java lives in the incidents instead), a bundler toolchain.

**D2. BM25 retrieval.** The Meta Model API offers no embeddings endpoint, and BM25 is
deterministic and testable. Rejected for now: a third-party embedding provider (another key,
another data path) and an LLM reranker (cost per query). Revisit with pgvector after the
hackathon.

**D3. The shared board admits evidence only through a verifying tool.** Agents that read each
other's unverified claims amplify hallucinations. Rejected: free-form agent chat, and majority
voting (agreement between agents running the same model is not independent evidence).

**D4. Cooperative pre-emption at turn boundaries.** An in-flight model call cannot be usefully
interrupted, so a more urgent task pauses an agent at its next turn boundary, and the paused
agent resumes with a summary of what changed. Rejected: aborting in-flight calls (wasted spend,
lost context).

**D5. Governance in deterministic code, approvals bound to a change hash.** The model proposes
and the control plane decides. Rejected: asking the model to respect approvals in its prompt
(prompts are not enforcement), and role-free "approve" buttons.

**D6. Production remediation is simulated.** Patches are applied to an isolated copy. We have no
authority over any real system, and the hackathon demo must not imply otherwise.

**D7. Self-repair changes only skills, and cannot see its grader.** The constitution is pinned
in code; validation scores use answer keys the Doctor cannot read. Rejected: letting the Doctor
edit prompts, policy and evaluation together (a system that controls its goal and its judge can
"improve" its score without improving).

**D8. Open source, no obfuscation.** Hackathon rules require an open-source repository, and
hiding code is not a security control: secrets stay in environment variables, and live use is
gated by access codes. Post-hackathon option: open-core, with the engine public and the learned
skill library and hosting private.

**D9. Offline demo with a labelled scripted model, not recorded fakes.** It lets judges explore
every flow without a key, without passing scripted output off as Muse.

**D10. JSON-file state for now.** Atomic writes and per-process serialisation are enough for a
single-instance demo. Rejected for the hackathon: PostgreSQL with an outbox, and an OPA policy
service. Both are on the roadmap.
