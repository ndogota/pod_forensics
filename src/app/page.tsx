export default function HomePage() {
  return (
    <main>
      <h1>pod_forensics</h1>
      <p>
        An experimental tool. It runs an agent that uses read-only diagnostic
        tools to form a root cause hypothesis for a failing Kubernetes workload,
        then scores each diagnosis against known ground truth.
      </p>
      <p>
        This is a controlled demonstration of an agentic diagnosis loop and an
        eval methodology over a finite, known failure taxonomy. It is not a
        production SRE tool.
      </p>
      <p>
        Dashboard shell only. Eval reports and run traces will render here once
        they are committed.
      </p>
    </main>
  );
}
