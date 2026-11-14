"""Keep sender access tokens out of server logs.

The sender status API is `/api/public/r/<token>…`, so the raw token is part of the request
path, and uvicorn's access log records every request path. This filter rewrites any
`/r/<token>` in a log record (message and arguments) to `/r/[secure link removed]` before
it is emitted. It is installed on the uvicorn access and error loggers and on the root
logger at app construction.
"""

from __future__ import annotations

import logging

from .store import redact_sender_links

_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn", "")


class SenderTokenRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_sender_links(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_sender_links(arg) if isinstance(arg, str) else arg for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: redact_sender_links(value) if isinstance(value, str) else value
                           for key, value in record.args.items()}
        return True


def install_sender_token_log_redaction() -> None:
    """Idempotent: adds one filter per logger."""
    for name in _LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(existing, SenderTokenRedactionFilter) for existing in logger.filters):
            logger.addFilter(SenderTokenRedactionFilter())
