//! Offline P2P model only. This entire module is absent from non-test builds.
use futures_util::{FutureExt, StreamExt};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use zbus::{
    connection::Builder,
    object_server::SignalEmitter,
    zvariant::{OwnedObjectPath, OwnedValue},
};
const UNIT: &str = "dyoffice-fixture-readonly.service";
const JOB: &str = "/org/freedesktop/systemd1/job/7";
type Properties = Vec<(String, OwnedValue)>;
type Auxiliary = Vec<(String, Properties)>;
#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1"
)]
trait Manager {
    fn subscribe(&self) -> zbus::Result<()>;
    fn start_transient_unit(
        &self,
        name: &str,
        mode: &str,
        properties: Properties,
        aux: Auxiliary,
    ) -> zbus::Result<OwnedObjectPath>;
    #[zbus(signal)]
    fn job_removed(
        &self,
        id: u32,
        job: OwnedObjectPath,
        unit: String,
        result: String,
    ) -> zbus::Result<()>;
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    NeverStarted,
    JobObserved { job_id: u32, result: String },
    Quarantined,
}
struct Attempt {
    generation: u64,
    attempted: bool,
    used: bool,
    phase: Phase,
}
impl Attempt {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            attempted: false,
            used: false,
            phase: Phase::NeverStarted,
        }
    }
    async fn run(&mut self, fixture: &Fixture, budget: Duration) -> Phase {
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        self.run_with_cancel(fixture, budget, receiver).await
    }
    async fn run_with_cancel(
        &mut self,
        fixture: &Fixture,
        budget: Duration,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Phase {
        if self.used
            || fixture.generation != self.generation
            || budget.is_zero()
            || budget > Duration::from_secs(1)
        {
            if self.attempted {
                self.phase = Phase::Quarantined
            }
            return self.phase.clone();
        }
        self.used = true;
        if *cancel.borrow() {
            return self.phase.clone();
        }
        let outcome = tokio::select! {
         result=tokio::time::timeout(budget,self.observe(fixture))=>result.ok().and_then(Result::ok),
         _=cancel.changed()=>None,
        };
        self.phase = if *cancel.borrow() { None } else { outcome }.unwrap_or(if self.attempted {
            Phase::Quarantined
        } else {
            Phase::NeverStarted
        });
        self.phase.clone()
    }
    async fn observe(&mut self, fixture: &Fixture) -> Result<Phase, ()> {
        let proxy = ManagerProxy::new(&fixture.client).await.map_err(|_| ())?;
        let mut signals = proxy.receive_job_removed().await.map_err(|_| ())?;
        fixture.trace.lock().unwrap().push("stream_ready".into());
        proxy.subscribe().await.map_err(|_| ())?;
        // Set before polling the mutating call. Lost response is never "not started".
        self.attempted = true;
        let start = proxy.start_transient_unit(
            UNIT,
            "fail",
            crate::systemd_probe::candidate_properties(),
            vec![],
        );
        tokio::pin!(start);
        let mut returned: Option<(u32, String)> = None;
        let mut events: Vec<(u32, String, String, String)> = vec![];
        let mut bytes = 0usize;
        loop {
            tokio::select! {
             reply=&mut start,if returned.is_none()=>{
              let path=reply.map_err(|_|())?.to_string();
              let number=path.strip_prefix("/org/freedesktop/systemd1/job/").ok_or(())?;
              let id=number.parse::<u32>().map_err(|_|())?;
              if id==0||id.to_string()!=number{return Err(())}
              returned=Some((id,path));
             },
             signal=signals.next()=>{
              let signal=signal.ok_or(())?;let args=signal.args().map_err(|_|())?;
              let id=*args.id();let path=args.job().to_string();let unit=args.unit().to_string();let result=args.result().to_string();
              if path.len()>128||unit.len()>128||result.len()>32||!matches!(result.as_str(),"done"|"failed"|"canceled"|"timeout"|"dependency"|"skipped"){return Err(())}
              bytes+=path.len()+unit.len()+result.len()+4;
              if events.len()>=16||bytes>4096{return Err(())}
              events.push((id,path,unit,result));
             },
            }
            if let Some((id, path)) = &returned {
                // Drain only already queued signals before interpreting early completion.
                // This is bounded; later events require the future continuous reconciler.
                loop {
                    match signals.next().now_or_never() {
                        None => break,
                        Some(None) => return Err(()),
                        Some(Some(signal)) => {
                            let args = signal.args().map_err(|_| ())?;
                            let path = args.job().to_string();
                            let unit = args.unit().to_string();
                            let result = args.result().to_string();
                            if path.len() > 128
                                || unit.len() > 128
                                || result.len() > 32
                                || !matches!(
                                    result.as_str(),
                                    "done"
                                        | "failed"
                                        | "canceled"
                                        | "timeout"
                                        | "dependency"
                                        | "skipped"
                                )
                            {
                                return Err(());
                            }
                            bytes += path.len() + unit.len() + result.len() + 4;
                            if events.len() >= 16 || bytes > 4096 {
                                return Err(());
                            }
                            events.push((*args.id(), path, unit, result));
                        }
                    }
                }
                let matching: Vec<_> = events
                    .iter()
                    .filter(|event| event.0 == *id && event.1 == *path && event.2 == UNIT)
                    .collect();
                if matching.len() > 1 {
                    return Err(());
                }
                if let Some(event) = matching.first() {
                    return Ok(Phase::JobObserved {
                        job_id: *id,
                        result: event.3.clone(),
                    });
                }
            }
        }
    }
    fn reconnect(&mut self, generation: u64) -> Result<(), ()> {
        if generation <= self.generation {
            return Err(());
        }
        self.generation = generation;
        if self.attempted {
            self.phase = Phase::Quarantined
        }
        // Deliberately keep used=true: reconnect is not authorization to retry start.
        Ok(())
    }
    fn must_retain(&self) -> bool {
        self.attempted
    }
}
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
}
struct FakeManager {
    behaviour: Behaviour,
    starts: Arc<AtomicUsize>,
    trace: Arc<Mutex<Vec<String>>>,
}
#[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
impl FakeManager {
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
        assert_eq!(properties.len(), 6);
        assert!(!properties.iter().any(|(name, _)| name == "ExecStart"));
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
struct Fixture {
    generation: u64,
    client: zbus::Connection,
    server: zbus::Connection,
    starts: Arc<AtomicUsize>,
    trace: Arc<Mutex<Vec<String>>>,
}
impl Fixture {
    async fn new(generation: u64, behaviour: Behaviour) -> Self {
        let (s, c) = tokio::net::UnixStream::pair().unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let trace = Arc::new(Mutex::new(Vec::new()));
        let manager = FakeManager {
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
    assert_eq!(
        *f.trace.lock().unwrap(),
        ["stream_ready", "subscribe", "start"]
    );
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
        Phase::NeverStarted
    );
    assert_eq!(f.starts.load(Ordering::SeqCst), 0);
    assert!(!a.must_retain());
    let f = Fixture::new(2, Behaviour::Fast).await;
    f.server.clone().close().await.unwrap();
    let mut a = Attempt::new(2);
    assert_eq!(
        a.run(&f, Duration::from_millis(100)).await,
        Phase::NeverStarted
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
        Phase::NeverStarted
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
        Phase::NeverStarted
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
        Phase::NeverStarted
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
