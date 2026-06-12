import { define } from "../utils.ts";

export default define.page(function Home() {
  return (
    <main class="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 class="text-4xl font-bold">StudyHub</h1>
      <p class="text-gray-600">
        User study management for the lab — implementation in progress.
      </p>
    </main>
  );
});
