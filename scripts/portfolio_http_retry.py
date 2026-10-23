#!/usr/bin/env python3
"""Transport-only retry for the portfolio exact certification (portfolio-five-digital-target-exact-cert).

Retries ONLY failures where no usable HTTP response arrived (timeout, connection reset/refused/aborted,
DNS failure, truncated read) or the edge answered HTTP 5xx/429. Any response that arrived with another
status is returned/raised on the FIRST attempt, and the caller validates content/hash/contract exactly
once: a successful but divergent response is never re-fetched, so divergence can never be retried away.

Every attempt is logged as one line `HTTP_ATTEMPT url=... attempt=i/N outcome=...` and kept in
`attempt_log` (written to the evidence by the caller).
"""
import http.client
import socket
import time
import urllib.error
import urllib.request

ATTEMPTS = 3
BACKOFF_SECONDS = (2, 5)  # sleep after attempt 1 and after attempt 2
TIMEOUT_SECONDS = 25

attempt_log = []


class TransportExhausted(RuntimeError):
    """All attempts failed at the transport level (or with 5xx/429)."""


def _is_retryable_status(code):
    return code == 429 or 500 <= code <= 599


def _print(msg):
    print(msg, flush=True)


def classify(exc):
    """Return a short transport class for retryable errors, or None if the error is NOT transport-level."""
    if isinstance(exc, urllib.error.HTTPError):
        return f"http_{exc.code}" if _is_retryable_status(exc.code) else None
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, BaseException):
            return classify(reason)
        text = str(reason).lower()
        if "timed out" in text:
            return "timeout"
        return None
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, socket.gaierror):
        return "dns"
    # RemoteDisconnected subclasses ConnectionResetError: check it first for a precise class.
    if isinstance(exc, (http.client.RemoteDisconnected, http.client.IncompleteRead, BrokenPipeError)):
        return "connection_dropped"
    if isinstance(exc, ConnectionResetError):
        return "connection_reset"
    if isinstance(exc, ConnectionRefusedError):
        return "connection_refused"
    if isinstance(exc, ConnectionAbortedError):
        return "connection_aborted"
    return None


def _default_open(req, timeout):
    return urllib.request.urlopen(req, timeout=timeout)


def get(url, headers=None, *, opener=_default_open, sleep=time.sleep, attempts=ATTEMPTS,
        backoff=BACKOFF_SECONDS, log=_print):
    """GET url; returns (status, body, headers_lower, elapsed_ms_of_successful_attempt)."""
    hdr = {"User-Agent": "ZEVANORY-PORTFOLIO-CERT/2.0", "Accept": "text/html,application/json"}
    if headers:
        hdr.update(headers)
    last = None
    for i in range(1, attempts + 1):
        req = urllib.request.Request(url, headers=hdr)
        t = time.perf_counter()
        try:
            with opener(req, TIMEOUT_SECONDS) as r:
                body = r.read()
                rh = {k.lower(): v for k, v in r.headers.items()}
                code = r.status
        except Exception as exc:  # noqa: BLE001 - classified below; non-transport errors re-raised as-is
            kind = classify(exc)
            ms = round((time.perf_counter() - t) * 1000, 2)
            if kind is None:
                attempt_log.append({"url": url, "attempt": i, "outcome": "non_transport_error",
                                    "error": type(exc).__name__, "ms": ms})
                log(f"HTTP_ATTEMPT url={url} attempt={i}/{attempts} outcome=non_transport_error "
                    f"error={type(exc).__name__} retry=no")
                raise
            last = exc
            will_retry = i < attempts
            attempt_log.append({"url": url, "attempt": i, "outcome": kind, "error": type(exc).__name__,
                                "ms": ms, "retry": will_retry})
            delay = backoff[min(i - 1, len(backoff) - 1)] if will_retry else 0
            log(f"HTTP_ATTEMPT url={url} attempt={i}/{attempts} outcome={kind} error={type(exc).__name__} "
                f"retry={'yes backoff=' + str(delay) + 's' if will_retry else 'no'}")
            if will_retry:
                sleep(delay)
            continue
        ms = round((time.perf_counter() - t) * 1000, 2)
        attempt_log.append({"url": url, "attempt": i, "outcome": "response", "status": code, "ms": ms})
        log(f"HTTP_ATTEMPT url={url} attempt={i}/{attempts} outcome=response status={code} ms={ms}")
        return code, body, rh, ms
    raise TransportExhausted(f"{url}: {attempts} attempts failed at transport level; last={last!r}") from last
