"""Streaming primitives for the acquisition pipeline.

The JobStream wrapper sits on top of Redis Streams and provides idempotent
discovery (resumable on retry), bounded fan-out via consumer groups, and
crash recovery via XAUTOCLAIM. See docs/design/stream-pipeline.md.
"""
from .redis_stream import DirQueue, DirQueueRedisError, JobStream, JobStreamConfig, build_job_stream

__all__ = ["DirQueue", "DirQueueRedisError", "JobStream", "JobStreamConfig", "build_job_stream"]
