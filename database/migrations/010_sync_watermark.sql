-- Divergence detection for sync-peer.
--
-- Two machines each run their own database and are used one at a time. Copying
-- the newer state over the older one is safe ONLY while the older side holds
-- nothing the newer side has not seen. A timestamp alone cannot tell you that:
-- if work was edited on Monday and home on Tuesday without a sync in between,
-- Tuesday is newer and Monday's work would be silently discarded.
--
-- So record what the two machines held at the moment they last agreed. Next
-- time, a side whose hash still equals that watermark has not changed, and a
-- side whose hash differs has. Both changed means the states diverged, and no
-- amount of clock reading makes that mergeable — the script must refuse.
--
-- One row per (app, peer): a machine may be synced against more than one other.

CREATE TABLE IF NOT EXISTS sync_watermark (
    app          text NOT NULL,
    peer         text NOT NULL,
    payload_hash text NOT NULL,
    local_version integer,
    peer_version  integer,
    synced_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app, peer)
);
