use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use zbus::object_server::SignalEmitter;
#[derive(Clone, Copy)]
enum Behaviour {
    Fast,
    WrongId,
    WrongUnit,
    WrongPath,
    SubscribeFails,
    NoReply,
    Duplicate,
    Flood,
    Failed,
    SubscribeSlow,
    AfterReply,
    Malformed,
    WrongReply,
    StartError,
    SignalNoReply,
    LargeEvent,
    UnknownResult,
    UnitMissing,
    WrongUnitIdentity,
    RootCgroup,
    ChangedInvocation,
    SlowUnitRead,
    ChangedCgroup,
    WrongResource(u8),
    WrongResourceType,
    MissingResource,
    SlowResource,
    ChangedResource,
    WrongSecurity(u8),
    MissingSecurity,
    SlowSecurity,
    ChangedSecurity,
    ChangedUnitPath,
}
struct FakeManager {
    unit_queries: AtomicUsize,
    behaviour: Behaviour,
    starts: Arc<AtomicUsize>,
    pub(super) trace: Arc<Mutex<Vec<String>>>,
}
#[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
impl FakeManager {
    fn get_unit(&self, name: &str) -> zbus::fdo::Result<OwnedObjectPath> {
        assert_eq!(name, UNIT);
        if self.unit_queries.fetch_add(1, Ordering::SeqCst) > 0
            && matches!(self.behaviour, Behaviour::ChangedUnitPath)
        {
            return Ok("/org/freedesktop/systemd1/unit/replaced"
                .try_into()
                .unwrap());
        }
        if matches!(self.behaviour, Behaviour::UnitMissing) {
            return Err(zbus::fdo::Error::Failed("missing unit".into()));
        }
        Ok(
            "/org/freedesktop/systemd1/unit/fixture_returned_not_derived"
                .try_into()
                .unwrap(),
        )
    }

    async fn subscribe(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        assert_eq!(header.signature().to_string(), "");
        self.trace.lock().unwrap().push("subscribe".into());
        if matches!(self.behaviour, Behaviour::SubscribeSlow) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if matches!(self.behaviour, Behaviour::SubscribeFails) {
            Err(zbus::fdo::Error::Failed("fixture denied".into()))
        } else {
            Ok(())
        }
    }
    async fn start_transient_unit(
        &self,
        name: &str,
        mode: &str,
        properties: Properties,
        aux: Auxiliary,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        assert_eq!(header.signature().to_string(), "(ssa(sv)a(sa(sv)))");
        assert_eq!(name, UNIT);
        assert_eq!(mode, "fail");
        assert!(aux.is_empty());
        assert_eq!(properties.len(), 19);
        assert!(
            properties.iter().any(|(name, value)| name == "ExecStart"
                && value.value_signature().to_string() == "a(sasb)")
        );
        assert!(self.trace.lock().unwrap().iter().any(|v| v == "subscribe"));
        self.trace.lock().unwrap().push("start".into());
        self.starts.fetch_add(1, Ordering::SeqCst);
        if matches!(self.behaviour, Behaviour::StartError) {
            return Err(zbus::fdo::Error::Failed(
                "fixture start response lost/failed".into(),
            ));
        }
        if matches!(self.behaviour, Behaviour::Malformed) {
            emitter
                .connection()
                .emit_signal(
                    None::<&str>,
                    emitter.path(),
                    "org.freedesktop.systemd1.Manager",
                    "JobRemoved",
                    &"wrong signature",
                )
                .await
                .unwrap();
            return Ok(JOB.try_into().unwrap());
        }
        if matches!(self.behaviour, Behaviour::AfterReply) {
            let emitter = emitter.to_owned();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                let _ =
                    FakeManager::job_removed(&emitter, 7, &JOB.try_into().unwrap(), UNIT, "done")
                        .await;
            });
            return Ok(JOB.try_into().unwrap());
        }
        if matches!(self.behaviour, Behaviour::NoReply) {
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Ok(JOB.try_into().unwrap());
        }
        let n = match self.behaviour {
            Behaviour::Duplicate => 2,
            Behaviour::Flood => 40,
            _ => 1,
        };
        for _ in 0..n {
            let id = if matches!(self.behaviour, Behaviour::WrongId | Behaviour::Flood) {
                8
            } else {
                7
            };
            let path = if matches!(self.behaviour, Behaviour::WrongPath) {
                "/org/freedesktop/systemd1/job/8"
            } else {
                JOB
            };
            let large = "x".repeat(129);
            let unit = if matches!(self.behaviour, Behaviour::LargeEvent) {
                large.as_str()
            } else if matches!(self.behaviour, Behaviour::WrongUnit) {
                "foreign.service"
            } else {
                UNIT
            };
            let result = if matches!(self.behaviour, Behaviour::UnknownResult) {
                "invented"
            } else if matches!(self.behaviour, Behaviour::Failed) {
                "failed"
            } else {
                "done"
            };
            Self::job_removed(
                &emitter,
                id,
                &OwnedObjectPath::try_from(path).unwrap(),
                unit,
                result,
            )
            .await
            .map_err(|_| zbus::fdo::Error::Failed("signal disconnected".into()))?;
        }
        // Completion signals intentionally precede this method reply.
        if matches!(self.behaviour, Behaviour::SignalNoReply) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if matches!(self.behaviour, Behaviour::WrongReply) {
            return Ok("/org/freedesktop/systemd1/unit/foreign".try_into().unwrap());
        }
        Ok(JOB.try_into().unwrap())
    }
    #[zbus(signal)]
    async fn job_removed(
        emitter: &SignalEmitter<'_>,
        id: u32,
        job: &OwnedObjectPath,
        unit: &str,
        result: &str,
    ) -> zbus::Result<()>;
}
struct FakeUnit {
    behaviour: Behaviour,
    reads: AtomicUsize,
}
#[zbus::interface(name = "org.freedesktop.systemd1.Unit")]
impl FakeUnit {
    #[zbus(property)]
    fn id(&self) -> &str {
        if matches!(self.behaviour, Behaviour::WrongUnitIdentity) {
            "other.service"
        } else {
            UNIT
        }
    }
    #[zbus(property, name = "InvocationID")]
    async fn invocation_id(&self) -> Vec<u8> {
        if matches!(self.behaviour, Behaviour::SlowUnitRead) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let read = self.reads.fetch_add(1, Ordering::SeqCst);
        vec![
            if matches!(self.behaviour, Behaviour::ChangedInvocation) && read > 0 {
                2
            } else {
                1
            };
            16
        ]
    }
}

struct FakeService {
    resource_reads: AtomicUsize,
    security_reads: AtomicUsize,
    reads: AtomicUsize,
    behaviour: Behaviour,
}
#[zbus::interface(name = "org.freedesktop.systemd1.Service")]
impl FakeService {
    #[zbus(property)]
    async fn memory_max(&self) -> zbus::fdo::Result<OwnedValue> {
        if matches!(self.behaviour, Behaviour::WrongResourceType) {
            return Ok((512 * 1024 * 1024u32).into());
        }
        if matches!(self.behaviour, Behaviour::MissingResource) {
            return Err(zbus::fdo::Error::UnknownProperty("absent".into()));
        }
        if matches!(self.behaviour, Behaviour::SlowResource) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let n = self.resource_reads.fetch_add(1, Ordering::SeqCst);
        Ok((if matches!(self.behaviour, Behaviour::WrongResource(0))
            || (matches!(self.behaviour, Behaviour::ChangedResource) && n > 0)
        {
            u64::MAX
        } else {
            512 * 1024 * 1024
        })
        .into())
    }
    #[zbus(property, name = "MemorySwapMax")]
    fn memory_swap_max(&self) -> u64 {
        if matches!(self.behaviour, Behaviour::WrongResource(1)) {
            u64::MAX
        } else {
            0
        }
    }
    #[zbus(property, name = "TasksMax")]
    fn tasks_max(&self) -> u64 {
        if matches!(self.behaviour, Behaviour::WrongResource(2)) {
            u64::MAX
        } else {
            64
        }
    }
    #[zbus(property, name = "CPUQuotaPerSecUSec")]
    fn cpu_quota_per_sec_usec(&self) -> u64 {
        if matches!(self.behaviour, Behaviour::WrongResource(3)) {
            u64::MAX
        } else {
            1_000_000
        }
    }
    #[zbus(property, name = "RuntimeMaxUSec")]
    fn runtime_max_usec(&self) -> u64 {
        if matches!(self.behaviour, Behaviour::WrongResource(4)) {
            u64::MAX
        } else {
            30_000_000
        }
    }
    #[zbus(property, name = "TimeoutStopUSec")]
    fn timeout_stop_usec(&self) -> u64 {
        if matches!(self.behaviour, Behaviour::WrongResource(5)) {
            u64::MAX
        } else {
            5_000_000
        }
    }
    #[zbus(property, name = "UMask")]
    fn umask(&self) -> u32 {
        if matches!(self.behaviour, Behaviour::WrongResource(6)) {
            0
        } else {
            63
        }
    }
    #[zbus(property)]
    fn kill_mode(&self) -> &str {
        if matches!(self.behaviour, Behaviour::WrongResource(7)) {
            "process"
        } else {
            "control-group"
        }
    }

    #[zbus(property)]
    async fn no_new_privileges(&self) -> zbus::fdo::Result<bool> {
        if matches!(self.behaviour, Behaviour::MissingSecurity) {
            return Err(zbus::fdo::Error::UnknownProperty("absent".into()));
        }
        if matches!(self.behaviour, Behaviour::SlowSecurity) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let n = self.security_reads.fetch_add(1, Ordering::SeqCst);
        Ok(!matches!(self.behaviour, Behaviour::WrongSecurity(0))
            && !(matches!(self.behaviour, Behaviour::ChangedSecurity) && n > 0))
    }
    #[zbus(property)]
    fn private_network(&self) -> bool {
        if matches!(self.behaviour, Behaviour::WrongSecurity(1)) {
            false
        } else {
            true
        }
    }
    #[zbus(property)]
    fn private_devices(&self) -> bool {
        if matches!(self.behaviour, Behaviour::WrongSecurity(2)) {
            false
        } else {
            true
        }
    }
    #[zbus(property, name = "RestrictSUIDSGID")]
    fn restrict_suid_sgid(&self) -> bool {
        if matches!(self.behaviour, Behaviour::WrongSecurity(3)) {
            false
        } else {
            true
        }
    }
    #[zbus(property)]
    fn lock_personality(&self) -> bool {
        if matches!(self.behaviour, Behaviour::WrongSecurity(4)) {
            false
        } else {
            true
        }
    }
    #[zbus(property)]
    fn protect_system(&self) -> &str {
        if matches!(self.behaviour, Behaviour::WrongSecurity(5)) {
            "full"
        } else {
            "strict"
        }
    }
    #[zbus(property)]
    fn protect_home(&self) -> &str {
        if matches!(self.behaviour, Behaviour::WrongSecurity(6)) {
            "read-only"
        } else {
            "yes"
        }
    }
    #[zbus(property)]
    fn capability_bounding_set(&self) -> u64 {
        if matches!(self.behaviour, Behaviour::WrongSecurity(7)) {
            1
        } else {
            0
        }
    }
    #[zbus(property)]
    fn control_group(&self) -> &str {
        if self.reads.fetch_add(1, Ordering::SeqCst) > 0
            && matches!(self.behaviour, Behaviour::ChangedCgroup)
        {
            return "/different.slice/service";
        }
        if matches!(self.behaviour, Behaviour::RootCgroup) {
            "/"
        } else {
            "/delegated.slice/non-derived.service"
        }
    }
}
pub(super) struct Fixture {
    pub(super) generation: u64,
    pub(super) client: zbus::Connection,
    server: zbus::Connection,
    starts: Arc<AtomicUsize>,
    pub(super) trace: Arc<Mutex<Vec<String>>>,
}
impl Fixture {
    async fn new(generation: u64, behaviour: Behaviour) -> Self {
        let (s, c) = tokio::net::UnixStream::pair().unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let trace = Arc::new(Mutex::new(Vec::new()));
        let manager = FakeManager {
            unit_queries: AtomicUsize::new(0),
            behaviour,
            starts: starts.clone(),
            trace: trace.clone(),
        };
        let server = Builder::unix_stream(s)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/org/freedesktop/systemd1", manager)
            .unwrap()
            .serve_at(
                "/org/freedesktop/systemd1/unit/fixture_returned_not_derived",
                FakeUnit {
                    behaviour,
                    reads: AtomicUsize::new(0),
                },
            )
            .unwrap()
            .serve_at(
                "/org/freedesktop/systemd1/unit/fixture_returned_not_derived",
                FakeService {
                    security_reads: AtomicUsize::new(0),
                    resource_reads: AtomicUsize::new(0),
                    behaviour,
                    reads: AtomicUsize::new(0),
                },
            )
            .unwrap()
            .build();
        let client = Builder::unix_stream(c).p2p().build();
        let (server, client) = tokio::try_join!(server, client).unwrap();
        Self {
            generation,
            client,
            server,
            starts,
            trace,
        }
    }
}
#[tokio::test]
async fn fast_job_signal_is_correlated_but_never_proves_stopped() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(200)).await,
        Phase::JobObserved {
            job_id: 7,
            result: "done".into()
        }
    );
    assert!(a.must_retain());
    assert_eq!(*f.trace.lock().unwrap(), ["subscribe", "start"]);
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn wrong_job_identity_and_bounded_noise_cannot_advance() {
    for behaviour in [
        Behaviour::WrongId,
        Behaviour::WrongUnit,
        Behaviour::WrongPath,
        Behaviour::Flood,
    ] {
        let f = Fixture::new(1, behaviour).await;
        let mut a = Attempt::new(1);
        assert_eq!(
            a.run(&f, Duration::from_millis(80)).await,
            Phase::Quarantined
        );
        assert!(a.must_retain());
        assert_eq!(f.starts.load(Ordering::SeqCst), 1)
    }
}
#[tokio::test]
async fn failed_job_is_only_metadata_and_not_stop_proof() {
    let f = Fixture::new(1, Behaviour::Failed).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(200)).await,
        Phase::JobObserved {
            job_id: 7,
            result: "failed".into()
        }
    );
    assert!(a.must_retain())
}
#[tokio::test]
async fn subscription_failure_and_preflight_disconnect_never_submit() {
    let f = Fixture::new(1, Behaviour::SubscribeFails).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::NotSubmitted
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 0);
    assert!(!a.must_retain());
    let f = Fixture::new(2, Behaviour::Fast).await;
    f.server.clone().close().await.unwrap();
    let mut a = Attempt::new(2);
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::NotSubmitted
    );
    assert!(!a.must_retain())
}
#[tokio::test]
async fn no_reply_then_reconnect_retains_and_never_resubmits_attempt() {
    let f = Fixture::new(1, Behaviour::NoReply).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(30)).await,
        Phase::Quarantined
    );
    assert!(a.must_retain());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    a.reconnect(2).unwrap();
    assert!(a.reconnect(1).is_err());
    let next = Fixture::new(2, Behaviour::Fast).await;
    assert_eq!(
        a.run(&next, Duration::from_millis(100)).await,
        Phase::Quarantined
    );
    assert_eq!(next.starts.load(Ordering::SeqCst), 0);
    tokio::time::sleep(Duration::from_millis(1050)).await;
    assert_eq!(a.phase, Phase::Quarantined)
}
#[tokio::test]
async fn disconnect_after_submit_does_not_release_or_make_unknown_a_success() {
    let f = Fixture::new(1, Behaviour::NoReply).await;
    let starts = f.starts.clone();
    let server = f.server.clone();
    let closer = tokio::spawn(async move {
        while starts.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await
        }
        server.close().await.unwrap()
    });
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(150)).await,
        Phase::Quarantined
    );
    closer.await.unwrap();
    assert!(a.must_retain())
}
#[tokio::test]
async fn cancellation_before_and_after_submit_is_fail_closed() {
    let f = Fixture::new(1, Behaviour::NoReply).await;
    let mut a = Attempt::new(1);
    let (tx, rx) = tokio::sync::watch::channel(true);
    assert_eq!(
        a.run_with_cancel(&f, Duration::from_millis(100), rx).await,
        Phase::NotSubmitted
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 0);
    drop(tx);
    let (tx, rx) = tokio::sync::watch::channel(false);
    let starts = f.starts.clone();
    let cancel = tokio::spawn(async move {
        while starts.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await
        }
        tx.send(true).unwrap()
    });
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run_with_cancel(&f, Duration::from_millis(100), rx).await,
        Phase::Quarantined
    );
    cancel.await.unwrap();
    assert!(a.must_retain())
}
#[tokio::test]
async fn duplicate_early_completion_is_ambiguous_not_a_stop_proof() {
    let f = Fixture::new(1, Behaviour::Duplicate).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(150)).await,
        Phase::Quarantined
    );
    assert!(a.must_retain())
}
#[tokio::test]
async fn wrong_generation_and_second_use_never_send_another_start() {
    let f = Fixture::new(2, Behaviour::Fast).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::NotSubmitted
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 0);
    let mut a = Attempt::new(2);
    assert!(matches!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::JobObserved { .. }
    ));
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::Quarantined
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 1)
}
#[tokio::test]
async fn subscribe_timeout_does_not_start_and_uses_total_budget() {
    let f = Fixture::new(1, Behaviour::SubscribeSlow).await;
    let mut a = Attempt::new(1);
    let started = tokio::time::Instant::now();
    assert_eq!(
        a.run(&f, Duration::from_millis(25)).await,
        Phase::NotSubmitted
    );
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(!a.must_retain());
    assert_eq!(f.starts.load(Ordering::SeqCst), 0)
}
#[tokio::test]
async fn reply_before_signal_also_correlates_without_claiming_unit_termination() {
    let f = Fixture::new(1, Behaviour::AfterReply).await;
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(200)).await,
        Phase::JobObserved {
            job_id: 7,
            result: "done".into()
        }
    );
    assert!(a.must_retain())
}
#[tokio::test]
async fn malformed_signature_wrong_reply_and_failed_method_quarantine() {
    for mode in [
        Behaviour::Malformed,
        Behaviour::WrongReply,
        Behaviour::StartError,
        Behaviour::SignalNoReply,
        Behaviour::LargeEvent,
        Behaviour::UnknownResult,
    ] {
        let f = Fixture::new(1, mode).await;
        let mut a = Attempt::new(1);
        assert_eq!(
            a.run(&f, Duration::from_millis(60)).await,
            Phase::Quarantined
        );
        assert!(a.must_retain());
        assert_eq!(f.starts.load(Ordering::SeqCst), 1)
    }
}
#[tokio::test]
async fn generated_manager_introspection_matches_official_argument_shapes() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let proxy = zbus::fdo::IntrospectableProxy::builder(&f.client)
        .destination("org.freedesktop.systemd1")
        .unwrap()
        .path("/org/freedesktop/systemd1")
        .unwrap()
        .build()
        .await
        .unwrap();
    let xml = proxy.introspect().await.unwrap();
    let method = xml
        .split("<method name=\"StartTransientUnit\">")
        .nth(1)
        .unwrap()
        .split("</method>")
        .next()
        .unwrap();
    assert_eq!(method.matches("direction=\"in\"").count(), 4);
    assert_eq!(method.matches("direction=\"out\"").count(), 1);
    for ty in [
        "type=\"s\"",
        "type=\"a(sv)\"",
        "type=\"a(sa(sv))\"",
        "type=\"o\"",
    ] {
        assert!(method.contains(ty), "{method}")
    }
    let signal = xml
        .split("<signal name=\"JobRemoved\">")
        .nth(1)
        .unwrap()
        .split("</signal>")
        .next()
        .unwrap();
    assert_eq!(signal.matches("type=\"u\"").count(), 1);
    assert_eq!(signal.matches("type=\"o\"").count(), 1);
    assert_eq!(signal.matches("type=\"s\"").count(), 2);
}

#[tokio::test]
async fn owner_loss_before_and_after_submission_is_not_retried() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let mut a = Attempt::new(1);
    assert_eq!(
        a.submit_on(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            Duration::from_millis(200),
            rx.clone(),
            std::future::ready(()),
            false
        )
        .await,
        Phase::NotSubmitted
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 0);
    let f = Fixture::new(1, Behaviour::NoReply).await;
    let mut a = Attempt::new(1);
    let loss = async { tokio::time::sleep(Duration::from_millis(30)).await };
    assert_eq!(
        a.submit_on(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            Duration::from_millis(200),
            rx,
            loss,
            false
        )
        .await,
        Phase::Quarantined
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::Quarantined
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
#[test]
fn fixed_launch_properties_encode_actual_setter_values() {
    let p = LaunchSpec::fixture().properties();
    let v = p
        .iter()
        .find(|(k, _)| k == "ExecStart")
        .unwrap()
        .1
        .try_clone()
        .unwrap();
    let commands: Vec<(String, Vec<String>, bool)> = v.try_into().unwrap();
    assert_eq!(
        commands,
        vec![("/fixture-only".into(), vec!["/fixture-only".into()], false)]
    );
    assert_eq!(p.iter().filter(|(k, _)| k == "ExecStart").count(), 1);
}

#[test]
fn signal_headers_require_pinned_sender_and_manager_path() {
    for (sender, path, accepted) in [
        (":1.9", "/org/freedesktop/systemd1", true),
        (":1.10", "/org/freedesktop/systemd1", false),
        (":1.9", "/wrong", false),
    ] {
        let message = zbus::Message::signal(path, "org.freedesktop.systemd1.Manager", "JobRemoved")
            .unwrap()
            .sender(sender)
            .unwrap()
            .build(&(7u32, OwnedObjectPath::try_from(JOB).unwrap(), UNIT, "done"))
            .unwrap();
        let signal = JobRemoved::from_message(message).unwrap();
        assert_eq!(validate_signal(&signal, ":1.9", true).is_ok(), accepted);
    }
}

#[tokio::test]
async fn owner_aba_during_final_query_cannot_return_job_observation() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let (_cancel, rx) = tokio::sync::watch::channel(false);
    let (changed, observed) = tokio::sync::oneshot::channel::<()>();
    let lost = async {
        let _ = observed.await;
    }
    .fuse();
    tokio::pin!(lost);
    let mut a = Attempt::new(1);
    // Same submit -> final query control flow used by fixed-system-bus entry.
    let query = async {
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
        changed.send(()).unwrap();
        tokio::task::yield_now().await;
        Ok("org.freedesktop.systemd1".to_string())
    };
    let result = a
        .submit_and_finalize(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            tokio::time::Instant::now() + Duration::from_millis(200),
            rx,
            lost.as_mut(),
            false,
            query,
        )
        .await;
    assert_eq!(result, Phase::Quarantined);
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::Quarantined
    );
    assert!(a.must_retain());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn done_job_binds_manager_returned_unit_path_and_cgroup_without_derivation() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let mut a = Attempt::new(1);
    assert!(matches!(
        a.run(&f, Duration::from_millis(500)).await,
        Phase::JobObserved { .. }
    ));
    let binding = a.unit_binding.as_ref().unwrap();
    assert_eq!(
        binding.object_path(),
        "/org/freedesktop/systemd1/unit/fixture_returned_not_derived"
    );
    assert_eq!(
        binding.control_group(),
        "/delegated.slice/non-derived.service"
    );
    assert!(a.must_retain()); // This observation is not stopped/clean/admitted proof.
}
#[tokio::test]
async fn unit_readback_failures_quarantine_and_cannot_replay() {
    for behaviour in [
        Behaviour::UnitMissing,
        Behaviour::WrongUnitIdentity,
        Behaviour::RootCgroup,
        Behaviour::ChangedInvocation,
        Behaviour::ChangedCgroup,
        Behaviour::ChangedUnitPath,
        Behaviour::SlowUnitRead,
    ] {
        let f = Fixture::new(1, behaviour).await;
        let mut a = Attempt::new(1);
        assert_eq!(
            a.run(&f, Duration::from_millis(100)).await,
            Phase::Quarantined
        );
        assert!(a.unit_binding.is_none());
        assert!(a.must_retain());
        a.reconnect(2).unwrap();
        assert_eq!(
            a.run(&f, Duration::from_millis(100)).await,
            Phase::Quarantined
        );
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn owner_loss_during_unit_readback_quarantines() {
    let f = Fixture::new(1, Behaviour::SlowUnitRead).await;
    let mut a = Attempt::new(1);
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let result = a
        .submit_on(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            Duration::from_millis(500),
            rx,
            async { tokio::time::sleep(Duration::from_millis(50)).await },
            false,
        )
        .await;
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn cancellation_during_unit_readback_quarantines() {
    let f = Fixture::new(1, Behaviour::SlowUnitRead).await;
    let mut a = Attempt::new(1);
    let (tx, rx) = tokio::sync::watch::channel(false);
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
    });
    let result = a.run_with_cancel(&f, Duration::from_millis(500), rx).await;
    cancel.await.unwrap();
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn final_owner_failure_and_deadline_clear_previously_read_binding() {
    for delayed in [false, true] {
        let f = Fixture::new(1, Behaviour::Fast).await;
        let mut a = Attempt::new(1);
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let result = a
            .submit_and_finalize(
                &f.client,
                "org.freedesktop.systemd1",
                &LaunchSpec::fixture(),
                tokio::time::Instant::now() + Duration::from_millis(100),
                rx,
                std::future::pending(),
                false,
                async {
                    if delayed {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    Err(())
                },
            )
            .await;
        assert_eq!(result, Phase::Quarantined);
        assert!(a.unit_binding.is_none());
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn reconnect_and_reuse_clear_a_successful_point_in_time_binding() {
    for reconnect in [false, true] {
        let f = Fixture::new(1, Behaviour::Fast).await;
        let mut a = Attempt::new(1);
        assert!(matches!(
            a.run(&f, Duration::from_millis(500)).await,
            Phase::JobObserved { .. }
        ));
        assert!(a.unit_binding.is_some());
        if reconnect {
            a.reconnect(2).unwrap();
        } else {
            assert_eq!(
                a.run(&f, Duration::from_millis(500)).await,
                Phase::Quarantined
            );
        }
        assert!(a.unit_binding.is_none());
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn final_owner_aba_clears_binding_even_when_query_returns_original_owner() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let mut a = Attempt::new(1);
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let result = a
        .submit_and_finalize(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            tokio::time::Instant::now() + Duration::from_millis(500),
            rx,
            async {
                let _ = started_rx.await;
            },
            false,
            async {
                let _ = started_tx.send(());
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok("org.freedesktop.systemd1".to_owned())
            },
        )
        .await;
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn security_readback_rejects_each_mismatch_missing_changed_and_slow_property() {
    let mut cases: Vec<_> = (0..8).map(Behaviour::WrongSecurity).collect();
    cases.extend([
        Behaviour::MissingSecurity,
        Behaviour::ChangedSecurity,
        Behaviour::SlowSecurity,
    ]);
    for behaviour in cases {
        let f = Fixture::new(1, behaviour).await;
        let mut a = Attempt::new(1);
        assert_eq!(
            a.run(&f, Duration::from_millis(120)).await,
            Phase::Quarantined
        );
        assert!(a.unit_binding.is_none());
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
        a.reconnect(2).unwrap();
        assert_eq!(
            a.run(&f, Duration::from_millis(120)).await,
            Phase::Quarantined
        );
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    }
}

struct WrongSecurityType;
#[zbus::interface(name = "org.freedesktop.systemd1.Service")]
impl WrongSecurityType {
    #[zbus(property)]
    fn control_group(&self) -> &str {
        "/delegated.slice/non-derived.service"
    }
    #[zbus(property)]
    fn no_new_privileges(&self) -> &str {
        "true"
    }
}
#[tokio::test]
async fn security_property_wrong_wire_type_is_not_coerced() {
    let f = Fixture::new(1, Behaviour::Fast).await;
    let path = "/org/freedesktop/systemd1/unit/fixture_returned_not_derived";
    // Removing Service retains the Unit interface/object (returns false).
    assert!(
        !f.server
            .object_server()
            .remove::<FakeService, _>(path)
            .await
            .unwrap()
    );
    assert!(
        f.server
            .object_server()
            .at(path, WrongSecurityType)
            .await
            .unwrap()
    );
    let mut a = Attempt::new(1);
    assert_eq!(
        a.run(&f, Duration::from_millis(500)).await,
        Phase::Quarantined
    );
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn owner_loss_during_security_readback_quarantines() {
    let f = Fixture::new(1, Behaviour::SlowSecurity).await;
    let mut a = Attempt::new(1);
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let result = a
        .submit_on(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            Duration::from_millis(500),
            rx,
            async { tokio::time::sleep(Duration::from_millis(50)).await },
            false,
        )
        .await;
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn cancellation_during_security_readback_quarantines() {
    let f = Fixture::new(1, Behaviour::SlowSecurity).await;
    let mut a = Attempt::new(1);
    let (tx, rx) = tokio::sync::watch::channel(false);
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
    });
    let result = a.run_with_cancel(&f, Duration::from_millis(500), rx).await;
    cancel.await.unwrap();
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn resource_readback_rejects_each_mismatch_missing_changed_and_slow_property() {
    let mut cases: Vec<_> = (0..8).map(Behaviour::WrongResource).collect();
    cases.extend([
        Behaviour::WrongResourceType,
        Behaviour::MissingResource,
        Behaviour::ChangedResource,
        Behaviour::SlowResource,
    ]);
    for behaviour in cases {
        let f = Fixture::new(1, behaviour).await;
        let mut a = Attempt::new(1);
        assert_eq!(
            a.run(&f, Duration::from_millis(120)).await,
            Phase::Quarantined
        );
        assert!(a.unit_binding.is_none());
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
        a.reconnect(2).unwrap();
        assert_eq!(
            a.run(&f, Duration::from_millis(120)).await,
            Phase::Quarantined
        );
        assert_eq!(f.starts.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn owner_loss_during_resource_readback_quarantines() {
    let f = Fixture::new(1, Behaviour::SlowResource).await;
    let mut a = Attempt::new(1);
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let result = a
        .submit_on(
            &f.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            Duration::from_millis(500),
            rx,
            async { tokio::time::sleep(Duration::from_millis(50)).await },
            false,
        )
        .await;
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn cancellation_during_resource_readback_quarantines() {
    let f = Fixture::new(1, Behaviour::SlowResource).await;
    let mut a = Attempt::new(1);
    let (tx, rx) = tokio::sync::watch::channel(false);
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
    });
    let result = a.run_with_cancel(&f, Duration::from_millis(500), rx).await;
    cancel.await.unwrap();
    assert_eq!(result, Phase::Quarantined);
    assert!(a.unit_binding.is_none());
    assert_eq!(f.starts.load(Ordering::SeqCst), 1);
}
