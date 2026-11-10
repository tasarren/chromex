import { errorMessage } from "@chromex/protocol"
import { FenceRefusal, ProfileChangeError } from "./pipe-input.ts"

/**
 * Progress of a composite profile change. `dispatch()` marks the first point where a command or a
 * profile write may have taken effect; `step()` records confirmed effects for the failure message.
 */
export class ProfileProgress {
  readonly steps: string[] = []
  dispatched = false

  step(step: string): void {
    this.steps.push(step)
  }

  dispatch(): void {
    this.dispatched = true
  }
}

/**
 * Classify a failed profile change. An error before anything was dispatched is a clean refusal, so
 * the fence ends and stays reusable. Once a command or write was sent, any failure — including a
 * timeout with no completed step and a filesystem error — may have applied an effect, so it is
 * uncertain even when `steps` is empty.
 */
export function profileFailure(cause: unknown, progress: ProfileProgress): Error {
  if (!progress.dispatched) return new FenceRefusal(errorMessage(cause), { cause })
  return new ProfileChangeError(errorMessage(cause), progress.steps, { cause })
}
