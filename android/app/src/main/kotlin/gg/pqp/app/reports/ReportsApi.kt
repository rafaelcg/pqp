package gg.pqp.app.reports

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * `POST /api/reports`, the one endpoint this feature has.
 *
 * An extension on `ApiClient` for the same reason the account and social ones
 * are: the fresh token per request, the cancellable call and the
 * `{"error": …}` body turned into an `ApiException` are exactly what this
 * needs, and none of it has to change.
 *
 * The response is closed rather than decoded. It carries the filed report back,
 * but the only thing this client does with a report is file it: there is no
 * queue screen on Android, and modelling `reportSchema` here would be a second
 * copy of a schema nothing reads. A refusal still arrives as an `ApiException`
 * carrying the server's own sentence, which is the only wording that knows
 * whether this was the hourly ceiling (429) or a subject the caller cannot see
 * (404, deliberately indistinguishable from one that does not exist).
 *
 * 201 for a new report and 200 for a duplicate both land here as success, which
 * is the same contract `POST /api/blocks` uses.
 */
suspend fun ApiClient.createReport(body: CreateReportBody) {
    val json = PqpJson.encodeToString(CreateReportBody.serializer(), body)
    execute(
        Request.Builder()
            .url(url("/api/reports"))
            .post(json.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
    ).close()
}
