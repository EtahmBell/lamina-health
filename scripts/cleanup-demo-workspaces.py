"""Delete expired anonymous demo workspaces and their Lamina-owned state."""

from backend.workflow import workflow_store

if __name__ == "__main__":
    removed = workflow_store.cleanup_expired_demo_workspaces()
    print(f"Removed {removed} expired demo workspace(s).")
