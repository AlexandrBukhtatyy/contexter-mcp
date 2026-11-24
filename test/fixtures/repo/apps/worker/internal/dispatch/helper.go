package dispatch

// retryLimit — сколько раз повторять отправку кадра.
const retryLimit = 3

// shouldRetry решает, повторять ли отправку.
func shouldRetry(attempt int) bool {
	return attempt < retryLimit
}
