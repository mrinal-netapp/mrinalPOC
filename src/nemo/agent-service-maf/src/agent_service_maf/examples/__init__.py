"""Example agent adapters demonstrating the BaseAgent implementation pattern.

This package contains reference implementations intended for:
- Testing and development (``EchoAgent`` is the primary test adapter).
- Documentation — showing new framework adapter authors how to implement BaseAgent.
- Integration tests that need a deterministic, dependency-free agent.

The example agents are registered with ``FrameworkRegistry`` at import time.
To register them in your application, import this package:

.. code-block:: python

    import agent_service_maf.examples  # registers EchoAgent

Or import directly:

.. code-block:: python

    from agent_service_maf.examples.echo_agent import EchoAgent
"""

from agent_service_maf.examples.echo_agent import EchoAgent

__all__ = ["EchoAgent"]
