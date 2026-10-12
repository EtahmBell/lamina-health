"""Stable demo PCP identity shared by workspace and consultation records."""

PCP_AGENT_ID = "agent-pcp-lianne-cha"  # Preserve stored consultation references.
PCP_NAME = "Dr. Lucy Saruhashi"
PCP_AGENT_NAME = "Dr. Lucy Saruhashi's Agent"
PCP_SENDER_NAME = "Dr. Lucy Saruhashi Agent"

# PCP_AGENT_ID above is a legacy identifier kept only so already-stored consult
# transcripts/messages keep resolving (see the comment on that line) -- it does
# not actually name Dr. Lucy Saruhashi's own agent. New subsystems that need her
# canonical agent identity (e.g. referral provenance) must use this instead.
LUCY_AGENT_ID = "agent-lucy-saruhashi"
