import type { ReportSubjectType } from "@pqp/shared";

/**
 * The phrase a report card puts before the name it is about ("a message from
 * X", "a Baú post by X", "the account X"). One place, so the two queues (a
 * server's and the instance's) cannot drift on a kind one of them forgot.
 * Anything that is not a message or a Baú thing reads as an account, which is
 * what every kind before these were.
 */
export function reportSubjectKey(
  subjectType: ReportSubjectType,
):
  | "reports.subjectMessage"
  | "reports.subjectBauPost"
  | "reports.subjectBauComment"
  | "reports.subjectAccount" {
  switch (subjectType) {
    case "message":
      return "reports.subjectMessage";
    case "bau_post":
      return "reports.subjectBauPost";
    case "bau_comment":
      return "reports.subjectBauComment";
    default:
      return "reports.subjectAccount";
  }
}
