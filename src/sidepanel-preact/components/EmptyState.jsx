const EXAMPLES = [
  'Search for recent AI news',
  'Fill out this form',
  'Find the best price for...',
];

export function EmptyState({ onSelectExample }) {
  return (
    <div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </div>
      <h2>Hanzi in Chrome</h2>
      <p>Describe what you want to accomplish and the AI will browse autonomously to complete your task.</p>
      <div class="empty-examples">
        {EXAMPLES.map((example, i) => (
          <button
            key={i}
            class="example-chip"
            onClick={() => onSelectExample(example)}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
