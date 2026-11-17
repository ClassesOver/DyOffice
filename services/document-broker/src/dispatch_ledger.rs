//! Restricted database observations. No conversion to runtime approval exists.
use postgres_native_tls::MakeTlsConnector;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle, time::Instant};
use tokio_postgres::{Client, Config, config::SslMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    Invalid,
    Unavailable,
    NotAttempted,
    Used,
    OutcomeUnknown,
}
#[derive(Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    classification: String,
    dispatch_id: String,
    reservation_id: String,
    reservation_version: u64,
    request_digest: String,
    broker_id: String,
    broker_boot_id: String,
    expires_at: String,
    consumed: bool,
}
struct Expected(Observation);
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn shape(o: &Observation) -> bool {
    uuid(&o.dispatch_id)
        && uuid(&o.broker_id)
        && uuid(&o.broker_boot_id)
        && !o.reservation_id.is_empty()
        && o.reservation_id.len() <= 256
        && o.reservation_id.is_ascii()
        && o.reservation_version > 0
        && o.reservation_version <= 9_007_199_254_740_991
        && o.request_digest.len() == 64
        && o.request_digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && o.expires_at.len() == 24
        && o.expires_at.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'.',
            23 => b == b'Z',
            _ => b.is_ascii_digit(),
        })
        && o.expires_at.ends_with('Z')
        && time::OffsetDateTime::parse(
            &o.expires_at,
            &time::format_description::well_known::Rfc3339,
        )
        .is_ok()
}
impl Expected {
    fn from_prepared(v: &Value) -> Result<Self, Failure> {
        let o: Observation = serde_json::from_value(v.clone()).map_err(|_| Failure::Invalid)?;
        if !shape(&o) || o.classification != "native_verified_prepared_observation" || o.consumed {
            return Err(Failure::Invalid);
        }
        Ok(Self(o))
    }
}
fn decode(v: Value, e: &Expected, history: bool) -> Result<Observation, Failure> {
    let o: Observation = serde_json::from_value(v).map_err(|_| Failure::Invalid)?;
    if !shape(&o) {
        return Err(Failure::Invalid);
    }
    let mut compare = o.clone();
    compare.classification = e.0.classification.clone();
    compare.consumed = e.0.consumed;
    if compare != e.0 {
        return Err(Failure::Invalid);
    }
    if history {
        if o.classification != "historical_dispatch_observation" {
            return Err(Failure::Invalid);
        }
    } else if !o.consumed
        || !matches!(
            o.classification.as_str(),
            "native_verified_first_consumed_observation" | "already_consumed"
        )
    {
        return Err(Failure::Invalid);
    }
    Ok(o)
}

// Config is supplied only by the trusted server composition, never by wire data.
struct Deployment {
    config: Config,
    ca_pem: Vec<u8>,
}
struct Session {
    client: Client,
    driver: JoinHandle<()>,
    schema: String,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.driver.abort();
    }
}
impl Session {
    async fn tls(d: Deployment, deadline: Instant) -> Result<Self, Failure> {
        let mut config = d.config;
        config.ssl_mode(SslMode::Require);
        let ca = native_tls::Certificate::from_pem(&d.ca_pem).map_err(|_| Failure::Invalid)?;
        let mut builder = native_tls::TlsConnector::builder();
        builder
            .disable_built_in_roots(true)
            .add_root_certificate(ca);
        let connector = builder.build().map_err(|_| Failure::Invalid)?;
        let (client, connection) =
            tokio::time::timeout_at(deadline, config.connect(MakeTlsConnector::new(connector)))
                .await
                .map_err(|_| Failure::Unavailable)?
                .map_err(|_| Failure::Unavailable)?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Self {
            client,
            driver,
            schema: "public".into(),
        })
    }
    #[cfg(test)]
    async fn fixture(
        mut config: Config,
        schema: String,
        deadline: Instant,
    ) -> Result<Self, Failure> {
        if config.get_hosts() != [tokio_postgres::config::Host::Tcp("127.0.0.1".into())]
            || !schema
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || schema.is_empty()
        {
            return Err(Failure::Invalid);
        }
        config.ssl_mode(SslMode::Disable);
        let (client, connection) =
            tokio::time::timeout_at(deadline, config.connect(tokio_postgres::NoTls))
                .await
                .map_err(|_| Failure::Unavailable)?
                .map_err(|_| Failure::Unavailable)?;
        Ok(Self {
            client,
            driver: tokio::spawn(async move {
                let _ = connection.await;
            }),
            schema,
        })
    }
    async fn history(mut self, e: &Expected, deadline: Instant) -> Result<Observation, Failure> {
        let sql = format!(
            "SELECT {}.document_native_dispatch_history($1::text::uuid)",
            self.schema
        );
        let result = async {
            let row =
                tokio::time::timeout_at(deadline, self.client.query_one(&sql, &[&e.0.dispatch_id]))
                    .await
                    .map_err(|_| Failure::Unavailable)?
                    .map_err(|_| Failure::Unavailable)?;
            decode(row.try_get(0).map_err(|_| Failure::Invalid)?, e, true)
        }
        .await;
        self.driver.abort();
        let _ = tokio::time::timeout(Duration::from_millis(100), &mut self.driver).await;
        result
    }
}
struct Attempt {
    expected: Expected,
    challenge: String,
    used: bool,
    #[cfg(test)]
    lose_confirmation: bool,
}
impl Attempt {
    fn new(expected: Expected, challenge: String) -> Result<Self, Failure> {
        if !uuid(&challenge) {
            return Err(Failure::Invalid);
        }
        Ok(Self {
            expected,
            challenge,
            used: false,
            #[cfg(test)]
            lose_confirmation: false,
        })
    }
    async fn consume(
        &mut self,
        mut session: Session,
        deadline: Instant,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Observation, Failure> {
        if self.used {
            return Err(Failure::Used);
        }
        if *cancel.borrow() || Instant::now() >= deadline {
            return Err(Failure::NotAttempted);
        }
        self.used = true;
        let sql = format!(
            "SELECT {}.document_native_dispatch_consume($1::text::uuid,$2::text::uuid)",
            session.schema
        );
        let operation = async {
            let transaction = session
                .client
                .transaction()
                .await
                .map_err(|_| Failure::OutcomeUnknown)?;
            let row = transaction
                .query_one(&sql, &[&self.expected.0.dispatch_id, &self.challenge])
                .await
                .map_err(|_| Failure::OutcomeUnknown)?;
            let value = decode(
                row.try_get(0).map_err(|_| Failure::OutcomeUnknown)?,
                &self.expected,
                false,
            )
            .map_err(|_| Failure::OutcomeUnknown)?;
            transaction
                .commit()
                .await
                .map_err(|_| Failure::OutcomeUnknown)?;
            #[cfg(test)]
            if self.lose_confirmation {
                return Err(Failure::OutcomeUnknown);
            }
            Ok(value)
        };
        let result = tokio::select! {biased; _=cancel.changed()=>Err(Failure::OutcomeUnknown), result=tokio::time::timeout_at(deadline,operation)=>result.unwrap_or(Err(Failure::OutcomeUnknown))};
        // Drop aborts the connection driver on every path; cancellation is not proof of rollback.
        session.driver.abort();
        let _ = tokio::time::timeout(Duration::from_millis(100), &mut session.driver).await;
        drop(session);
        if *cancel.borrow() || Instant::now() >= deadline {
            Err(Failure::OutcomeUnknown)
        } else {
            result
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> serde_json::Value {
        serde_json::json!({"classification":"native_verified_first_consumed_observation","dispatchId":"12345678-1234-1234-1234-123456789abc","reservationId":"deployment/job/1/1","reservationVersion":2,"requestDigest":"a".repeat(64),"brokerId":"22345678-1234-1234-1234-123456789abc","brokerBootId":"32345678-1234-1234-1234-123456789abc","expiresAt":"2026-11-17T12:00:00.000Z","consumed":true})
    }
    #[test]
    fn strict_observation_binding() {
        let value = sample();
        let expected = Expected::from_prepared(&{
            let mut v = value.clone();
            v["classification"] = "native_verified_prepared_observation".into();
            v["consumed"] = false.into();
            v
        })
        .unwrap();
        assert!(decode(value.clone(), &expected, false).is_ok());
        for key in [
            "dispatchId",
            "reservationId",
            "requestDigest",
            "brokerId",
            "brokerBootId",
            "expiresAt",
        ] {
            let mut v = value.clone();
            v[key] = "wrong".into();
            assert!(decode(v, &expected, false).is_err());
        }
        let mut v = value.clone();
        v["extra"] = 1.into();
        assert!(decode(v, &expected, false).is_err());
        let mut v = value.clone();
        v["consumed"] = false.into();
        assert!(decode(v, &expected, false).is_err());
        let mut v = value;
        v["classification"] = "historical_observation".into();
        assert!(decode(v, &expected, false).is_err());
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    #[tokio::test]
    #[ignore = "requires isolated real PostgreSQL fixture; run Node integration recipe"]
    async fn child() {
        let path = std::env::var("DOCUMENT_PG_FIXTURE_FILE").expect("private fixture file");
        let v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut cfg = Config::new();
        cfg.host(v["host"].as_str().unwrap_or("127.0.0.1"))
            .port(v["port"].as_u64().unwrap() as u16)
            .user(v["user"].as_str().unwrap())
            .dbname(v["database"].as_str().unwrap());
        let budget = v["budgetMs"].as_u64().unwrap_or(3000);
        let deadline = Instant::now() + Duration::from_millis(budget);
        let saved_config = cfg.clone();
        let connection = if let Some(ca) = v["ca"].as_str() {
            Session::tls(
                Deployment {
                    config: cfg,
                    ca_pem: std::fs::read(ca).unwrap(),
                },
                deadline,
            )
            .await
        } else {
            Session::fixture(cfg, v["schema"].as_str().unwrap().into(), deadline).await
        };
        let result = match connection {
            Err(e) => serde_json::json!({"error":format!("{e:?}")}),
            Ok(mut session) => {
                // Only fixture changes schema; normal TLS config always uses fixed public schema.
                if let Some(schema) = v["schema"].as_str() {
                    assert!(
                        schema
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    );
                    session.schema = schema.into();
                }
                if v["mode"] == "connect" {
                    serde_json::json!({"connected":true})
                } else {
                    let expected = Expected::from_prepared(&v["expected"]).unwrap();
                    let result = if v["mode"] == "history" {
                        session.history(&expected, deadline).await
                    } else {
                        let mut attempt =
                            Attempt::new(expected, v["challenge"].as_str().unwrap().into())
                                .unwrap();
                        attempt.lose_confirmation = v["mode"] == "lost";
                        let (tx, rx) = watch::channel(v["mode"] == "pre-abort");
                        let cancel_task = if v["mode"] == "cancel" {
                            let tx = tx.clone();
                            Some(tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                                let _ = tx.send(true);
                            }))
                        } else {
                            None
                        };
                        let mut result = attempt.consume(session, deadline, rx.clone()).await;
                        if v["mode"] == "same-attempt" {
                            assert!(result.is_ok());
                            let mut second = if let Some(ca) = v["ca"].as_str() {
                                Session::tls(
                                    Deployment {
                                        config: saved_config,
                                        ca_pem: std::fs::read(ca).unwrap(),
                                    },
                                    deadline,
                                )
                                .await
                            } else {
                                Session::fixture(
                                    saved_config,
                                    v["schema"].as_str().unwrap().into(),
                                    deadline,
                                )
                                .await
                            }
                            .unwrap();
                            second.schema = v["schema"].as_str().unwrap().into();
                            result = attempt.consume(second, deadline, rx).await;
                        }
                        drop(tx);
                        if let Some(task) = cancel_task {
                            task.abort();
                        }
                        result
                    };
                    match result {
                        Ok(o) => {
                            serde_json::json!({"classification":o.classification,"consumed":o.consumed})
                        }
                        Err(e) => serde_json::json!({"error":format!("{e:?}")}),
                    }
                }
            }
        };
        std::fs::write(
            v["output"].as_str().unwrap(),
            serde_json::to_vec(&result).unwrap(),
        )
        .unwrap();
    }
}
