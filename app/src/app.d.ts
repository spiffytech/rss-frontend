import type { SessionUser } from '../server/auth'

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null
    }
  }
}

export {}
